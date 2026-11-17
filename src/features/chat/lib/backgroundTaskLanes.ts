import type { Message } from "@/shared/types/messages";
import {
  type BackgroundTask,
  isBackgroundTaskLive,
} from "../stores/backgroundTasksStore";

/** One run of a task, as a stretch of its lane. */
export interface LaneBlock {
  task: BackgroundTask;
  /**
   * A turn the agent took with no prompt open: after a wake-up it scheduled,
   * or to read what a background command reported.
   */
  agentTurn: boolean;
}

/**
 * What a chat keeps running behind its answers, as the lanes of a timeline:
 * a command with its reruns and the turns the agent took over its results,
 * the wake-ups the agent scheduled for itself, and its other own turns.
 */
export interface TaskLane {
  key: string;
  kind: "work" | "wakeups" | "agent";
  /** A command's own words. The other lanes are named by the view. */
  title?: string;
  /** Oldest first. */
  blocks: LaneBlock[];
}

/** The wake-up the agent last scheduled for itself and that has yet to fire. */
export interface PendingWakeup {
  at: number;
  reason?: string;
}

// claude-agent-acp names an autonomous turn by what started it, in Claude
// Code's words: "A scheduled wakeup fired (set for <time>)." after a
// ScheduleWakeup, and 'Background command "<description>" completed (exit
// code 0)' and the like after a task notification.
const WAKEUP_CAUSE = /^A scheduled wakeup fired/i;
const COMMAND_CAUSE = /^Background command "(.*)" /;
const WAKEUP_TOOL = "ScheduleWakeup";
/** A pending wake-up was scheduled by the latest turns, not the earliest. */
const WAKEUP_SCAN_MESSAGES = 60;

export function isLaneLive(lane: TaskLane): boolean {
  return lane.blocks.some((block) => isBackgroundTaskLive(block.task));
}

/** The runs of a lane's own work: a command's lane also holds agent turns. */
export function laneRuns(lane: TaskLane): LaneBlock[] {
  return lane.kind === "work"
    ? lane.blocks.filter((block) => !block.agentTurn)
    : lane.blocks;
}

/**
 * The block a lane is read by: the one still running, else its latest run.
 * A turn the agent took over a command's result speaks for the command only
 * while that turn is still going.
 */
export function laneHead(lane: TaskLane): LaneBlock | undefined {
  return (
    lane.blocks.findLast((block) => isBackgroundTaskLive(block.task)) ??
    laneRuns(lane).at(-1) ??
    lane.blocks.at(-1)
  );
}

export function buildTaskLanes(tasks: readonly BackgroundTask[]): TaskLane[] {
  const lanes = new Map<string, TaskLane>();
  const lane = (key: string, kind: TaskLane["kind"], title?: string) => {
    let found = lanes.get(key);
    if (!found) {
      found = { key, kind, ...(title ? { title } : {}), blocks: [] };
      lanes.set(key, found);
    }
    return found;
  };
  const turns: BackgroundTask[] = [];
  for (const task of tasks) {
    if (task.taskType === "turn") {
      turns.push(task);
      continue;
    }
    // The same command started again continues its lane.
    const title = task.description ?? task.name;
    lane(`work:${title ?? task.id}`, "work", title).blocks.push({
      task,
      agentTurn: false,
    });
  }
  for (const task of turns) {
    const cause = task.description ?? "";
    const block = { task, agentTurn: true };
    if (WAKEUP_CAUSE.test(cause)) {
      lane("wakeups", "wakeups").blocks.push(block);
      continue;
    }
    // A turn over a command's result belongs on that command's lane.
    const command = COMMAND_CAUSE.exec(cause)?.[1];
    const target =
      command === undefined ? undefined : lanes.get(`work:${command}`);
    (target ?? lane("agent", "agent")).blocks.push(block);
  }
  const ordered = [...lanes.values()];
  for (const each of ordered) {
    each.blocks.sort(
      (a, b) =>
        (a.task.startedAt ?? Number.POSITIVE_INFINITY) -
        (b.task.startedAt ?? Number.POSITIVE_INFINITY),
    );
  }
  // What still runs first, longest-running on top; then the latest to end.
  const startOf = (each: TaskLane) =>
    each.blocks.find((block) => isBackgroundTaskLive(block.task))?.task
      .startedAt ?? 0;
  const endOf = (each: TaskLane) =>
    Math.max(0, ...each.blocks.map((block) => block.task.endedAt ?? 0));
  return [
    ...ordered.filter(isLaneLive).sort((a, b) => startOf(a) - startOf(b)),
    ...ordered
      .filter((each) => !isLaneLive(each))
      .sort((a, b) => endOf(b) - endOf(a)),
  ];
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * The wake-up the agent last scheduled, read from its ScheduleWakeup call:
 * the tool answers "Next wakeup scheduled for 18:10:00 (in 3525s)", and
 * without that the call's own delay stands. A call that ends the loop, a
 * failed call and a chat that never scheduled one have none.
 */
export function latestScheduledWakeup(
  messages: readonly Message[] | undefined,
): PendingWakeup | null {
  if (!messages) return null;
  const from = Math.max(0, messages.length - WAKEUP_SCAN_MESSAGES);
  for (let index = messages.length - 1; index >= from; index--) {
    const message = messages[index];
    const call = message.content.findLast(
      (block) =>
        block.type === "toolRequest" &&
        (block.toolName ?? block.name) === WAKEUP_TOOL,
    );
    if (call?.type !== "toolRequest") continue;
    if (call.arguments.stop === true) return null;
    let answer: string | undefined;
    for (const later of messages.slice(index, index + 3)) {
      const response = later.content.find(
        (block) => block.type === "toolResponse" && block.id === call.id,
      );
      if (response?.type !== "toolResponse") continue;
      if (response.isError) return null;
      answer = response.result;
      break;
    }
    const answered = /\(in (\d+)s\)/.exec(answer ?? "")?.[1];
    const seconds =
      answered === undefined
        ? finite(call.arguments.delaySeconds)
        : Number(answered);
    const base = call.startedAt ?? message.created;
    if (seconds === undefined || !Number.isFinite(base)) return null;
    // Wake-ups are set on the minute; the call's clock is a second or two off.
    const at = base + seconds * 1000;
    const minute = Math.round(at / 60_000) * 60_000;
    const reason =
      typeof call.arguments.reason === "string"
        ? call.arguments.reason.trim()
        : "";
    return {
      at: Math.abs(minute - at) <= 5000 ? minute : at,
      ...(reason ? { reason } : {}),
    };
  }
  return null;
}

const MINUTE = 60_000;
/** How much of the past a timeline may show, in milliseconds. */
export const TIMELINE_SPANS: readonly number[] = [
  5, 15, 30, 60, 180, 360, 720, 1440,
].map((minutes) => minutes * MINUTE);
const TICK_STEPS = [1, 5, 10, 15, 30, 60, 120, 240].map(
  (minutes) => minutes * MINUTE,
);

/**
 * The span that shows everything still running from its start, and no less
 * than a quarter of an hour: what has ended may leave the left edge, what
 * runs is never cut off.
 */
export function fitTimelineSpan(lanes: readonly TaskLane[], now: number) {
  let oldest = now;
  for (const lane of lanes) {
    for (const { task } of lane.blocks) {
      if (isBackgroundTaskLive(task) && task.startedAt !== undefined)
        oldest = Math.min(oldest, task.startedAt);
    }
  }
  const needed = Math.max(15 * MINUTE, (now - oldest) * 1.08);
  return (
    TIMELINE_SPANS.find((span) => span >= needed) ??
    (TIMELINE_SPANS.at(-1) as number)
  );
}

/** `25m`, `2h`, `1h 30m`: a distance on the timeline's axis. */
export function formatAxisDistance(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest === 0
    ? `${minutes / 60}h`
    : `${Math.floor(minutes / 60)}h ${rest}m`;
}

/** The axis marks of a span, as distances back from now: at most six. */
export function timelineTicks(span: number): number[] {
  const step =
    TICK_STEPS.find((each) => span / each <= 6) ??
    (TICK_STEPS.at(-1) as number);
  const ticks: number[] = [];
  for (let back = step; back < span; back += step) ticks.push(back);
  return ticks;
}
