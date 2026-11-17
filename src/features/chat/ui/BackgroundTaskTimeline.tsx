import { useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  CircleAlert,
  CircleCheck,
  CirclePause,
  CircleStop,
  CircleX,
  Clock,
} from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { formatDate } from "@/shared/i18n/format";
import { Button } from "@/shared/ui/button";
import { FlockDart } from "@/shared/ui/flock-dart";
import { Spinner } from "@/shared/ui/spinner";
import {
  formatAxisDistance,
  isLaneLive,
  type LaneBlock,
  laneHead,
  laneRuns,
  type PendingWakeup,
  type TaskLane,
  timelineTicks,
} from "../lib/backgroundTaskLanes";
import {
  type BackgroundTask,
  type BackgroundTaskState,
  isBackgroundTaskLive,
} from "../stores/backgroundTasksStore";
import { formatWorkingTime } from "./LoadingFlock";

/** The room past "now", as a share of the past shown: where what is next goes. */
const FUTURE_SHARE = 0.16;
/** A wake-up this close is about to fire. */
const SOON_MS = 60_000;

/** The tone a state's count and word take; the ordinary ones take none. */
export const STATE_TONE: Partial<Record<BackgroundTaskState, string>> = {
  failed: "text-destructive",
  interrupted: "text-warning",
};

/** How a run is drawn on its lane, by how it stands. */
const BLOCK_TONE: Record<BackgroundTaskState, string> = {
  running: "bg-info/30 ring-1 ring-inset ring-info/45",
  paused: "bg-warning/25 ring-1 ring-inset ring-warning/45",
  completed: "bg-success/30 ring-1 ring-inset ring-success/40",
  failed: "bg-destructive/40 ring-1 ring-inset ring-destructive/60",
  stopped: "bg-muted-foreground/25 ring-1 ring-inset ring-muted-foreground/35",
  interrupted: "border border-dashed border-warning/70 bg-warning/15",
};

export function StateIcon({ state }: { state: BackgroundTaskState }) {
  switch (state) {
    case "running":
      return <Spinner decorative className="size-3.5" />;
    case "paused":
      return (
        <CirclePause
          aria-hidden="true"
          className="size-3.5 text-muted-foreground"
        />
      );
    case "completed":
      return (
        <CircleCheck aria-hidden="true" className="size-3.5 text-success" />
      );
    case "failed":
      return (
        <CircleX aria-hidden="true" className="size-3.5 text-destructive" />
      );
    case "interrupted":
      return (
        <CircleAlert aria-hidden="true" className="size-3.5 text-warning" />
      );
    case "stopped":
      return (
        <CircleStop
          aria-hidden="true"
          className="size-3.5 text-muted-foreground"
        />
      );
  }
}

/**
 * How long a task has run, or ran: counted to now while it is live and to its
 * end once it has one. Nothing for a task the host did not time, or one that
 * was over within the second.
 */
export function taskTime(task: BackgroundTask, now: number): string | null {
  if (task.startedAt === undefined) return null;
  const end = isBackgroundTaskLive(task) ? now : task.endedAt;
  if (end === undefined) return null;
  const seconds = (end - task.startedAt) / 1000;
  return seconds >= 1 ? formatWorkingTime(seconds) : null;
}

/** `18:10`, in the app's locale. */
export function clockTime(time: number): string {
  return formatDate(time, { hour: "2-digit", minute: "2-digit" });
}

/** How long until a moment, the way a status line counts: `42m`, `1h 05m`. */
export function timeUntil(at: number, now: number): string {
  return formatWorkingTime(Math.max(0, (at - now) / 1000));
}

export interface TimelineStop {
  disabled: boolean;
  run: () => void;
}

/**
 * What a chat keeps running, on a timeline that ends at now: a lane for each
 * piece of work, and on it a block for each run. A run still going grows
 * with the clock; runs of the same work are joined by a dashed line, which
 * for a wake-up the agent scheduled runs on to the mark of the next one. The
 * colour of a block is how the run stands, said again in words by its lane
 * and by the block's own label.
 */
export function BackgroundTaskTimeline({
  lanes,
  now,
  span,
  wakeup,
  animated,
  selectedId,
  onSelect,
  stopOf,
}: {
  lanes: readonly TaskLane[];
  now: number;
  /** How much of the past the timeline shows, in milliseconds. */
  span: number;
  /** The wake-up the agent scheduled and that has yet to fire. */
  wakeup?: PendingWakeup | null;
  /** False when the person asked for less motion. */
  animated: boolean;
  selectedId: string | null;
  onSelect: (taskId: string | null) => void;
  stopOf: (task: BackgroundTask) => TimelineStop | undefined;
}) {
  const { t } = useTranslation("chat");
  // A run seen ending settles with a flash; one found ended stands still.
  const seenLive = useRef(new Set<string>());

  const from = now - span;
  const total = span * (1 + FUTURE_SHARE);
  const at = (time: number) => ((time - from) / total) * 100;
  const nowAt = at(now);
  const ticks = timelineTicks(span);
  const motion = animated ? "true" : "false";

  const titleOf = (lane: TaskLane) =>
    lane.kind === "wakeups"
      ? t("backgroundTasks.lanes.wakeups")
      : lane.kind === "agent"
        ? t("backgroundTasks.lanes.agent")
        : (lane.title ?? t("backgroundTasks.task"));
  const describe = (lane: TaskLane, block: LaneBlock) => {
    const time = taskTime(block.task, now);
    return [
      block.agentTurn && lane.kind === "work"
        ? t("backgroundTasks.agentTurn")
        : titleOf(lane),
      [t(`backgroundTasks.${block.task.state}`), time]
        .filter(Boolean)
        .join(" · "),
    ].join(": ");
  };

  return (
    <div
      className="flex min-w-0 gap-3 px-3 pb-1.5 pt-1 text-xs"
      data-role="background-task-timeline"
    >
      <ul className="w-[32%] min-w-32 max-w-80 shrink-0 pt-5">
        {lanes.map((lane) => {
          const head = laneHead(lane);
          const waiting =
            lane.kind === "wakeups" && !isLaneLive(lane) && Boolean(wakeup);
          const title = titleOf(lane);
          const runs = laneRuns(lane).length;
          return (
            <li
              key={lane.key}
              data-testid="background-task-lane"
              data-lane={lane.kind}
              data-state={head?.task.state}
              className="flex h-7 min-w-0 items-center gap-2"
            >
              <span className="flex w-4 shrink-0 items-center justify-center">
                {waiting || !head ? (
                  <Clock
                    aria-hidden="true"
                    className="size-3.5 text-muted-foreground"
                  />
                ) : (
                  <StateIcon state={head.task.state} />
                )}
              </span>
              {head ? (
                <button
                  type="button"
                  title={title}
                  aria-pressed={selectedId === head.task.id}
                  onClick={() =>
                    onSelect(selectedId === head.task.id ? null : head.task.id)
                  }
                  className={cn(
                    "min-w-0 truncate rounded-sm text-left text-sm outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring",
                    !isLaneLive(lane) && !waiting && "text-muted-foreground",
                  )}
                >
                  {title}
                </button>
              ) : (
                <span className="min-w-0 truncate text-sm" title={title}>
                  {title}
                </span>
              )}
              {runs > 1 ? (
                <span
                  className="shrink-0 tabular-nums text-muted-foreground"
                  title={t("backgroundTasks.runs", {
                    count: runs,
                  })}
                >
                  {"×"}
                  {runs}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="@container relative min-w-0 flex-1">
        <div
          aria-hidden="true"
          className="relative h-5 text-[10px] tabular-nums text-muted-foreground"
        >
          {ticks.map((back, index) => (
            <span
              key={back}
              className={cn(
                "absolute top-0.5 -translate-x-1/2 whitespace-nowrap transition-[left] duration-1000 ease-linear",
                // A narrow track has room for every other mark's label.
                index % 2 === 0 && "@max-[26rem]:hidden",
              )}
              style={{ left: `${at(now - back)}%` }}
            >
              {"−"}
              {formatAxisDistance(back)}
            </span>
          ))}
          <span
            className="absolute top-0 -translate-x-1/2 rounded-xs bg-info/20 px-1 font-medium text-info"
            style={{ left: `${nowAt}%` }}
          >
            {t("backgroundTasks.now")}
          </span>
        </div>
        <div className="relative">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
          >
            {ticks.map((back) => (
              <span
                key={back}
                className="absolute inset-y-0 border-l border-dashed border-muted-foreground/20 transition-[left] duration-1000 ease-linear"
                style={{ left: `${at(now - back)}%` }}
              />
            ))}
            <span
              className="flock-lane-future absolute inset-y-0 right-0"
              style={{ left: `${nowAt}%` }}
            />
            <span
              className="absolute inset-y-0 w-px bg-info/70"
              style={{ left: `${nowAt}%` }}
            />
          </div>
          {lanes.map((lane) => {
            const shown = lane.blocks.flatMap((block) => {
              const { task } = block;
              if (task.startedAt === undefined) return [];
              const live = isBackgroundTaskLive(task);
              const end = live ? now : (task.endedAt ?? task.startedAt);
              if (end < from) return [];
              return [
                {
                  block,
                  live,
                  left: Math.max(0, at(task.startedAt)),
                  right: Math.min(nowAt, at(end)),
                  clipped: task.startedAt < from,
                },
              ];
            });
            const last = shown.at(-1);
            const next =
              lane.kind === "wakeups" && wakeup && wakeup.at > now
                ? // A wake-up further off than the timeline reaches waits at its edge.
                  Math.min(99, at(wakeup.at))
                : undefined;
            const soon =
              next !== undefined &&
              wakeup !== undefined &&
              wakeup !== null &&
              wakeup.at - now < SOON_MS;
            return (
              <div
                key={lane.key}
                className="relative h-7 border-t border-muted-foreground/10 first:border-t-0"
                data-testid="background-task-track"
              >
                {shown.slice(1).map((item, index) => {
                  const previous = shown[index];
                  return item.left > previous.right ? (
                    <span
                      key={`gap-${item.block.task.id}`}
                      aria-hidden="true"
                      className="flock-lane-dash absolute top-1/2 h-px -translate-y-1/2 text-muted-foreground/60 transition-[left,width] duration-1000 ease-linear"
                      style={{
                        left: `${previous.right}%`,
                        width: `${item.left - previous.right}%`,
                      }}
                    />
                  ) : null;
                })}
                {next !== undefined ? (
                  <>
                    <span
                      aria-hidden="true"
                      data-marching={motion}
                      className="flock-lane-dash absolute top-1/2 h-px -translate-y-1/2 text-muted-foreground transition-[left,width] duration-1000 ease-linear"
                      style={{
                        left: `${last ? last.right : nowAt}%`,
                        width: `${Math.max(0, next - (last ? last.right : nowAt))}%`,
                      }}
                    />
                    <span
                      data-testid="background-task-next"
                      title={[
                        t("backgroundTasks.nextAt", {
                          time: clockTime(wakeup?.at ?? now),
                        }),
                        wakeup?.reason,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      className={cn(
                        "absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border bg-background transition-[left] duration-1000 ease-linear",
                        soon
                          ? "border-info motion-safe:animate-pulse"
                          : "border-muted-foreground",
                      )}
                      style={{ left: `${next}%` }}
                    />
                  </>
                ) : null}
                {shown.map(({ block, live, left, right, clipped }) => {
                  const { task } = block;
                  if (live) seenLive.current.add(task.id);
                  const settled = !live && seenLive.current.has(task.id);
                  return (
                    <button
                      key={task.id}
                      type="button"
                      data-testid="background-task-block"
                      data-state={task.state}
                      data-turn={block.agentTurn ? "true" : undefined}
                      data-settled={settled && animated ? "true" : undefined}
                      aria-pressed={selectedId === task.id}
                      aria-label={describe(lane, block)}
                      title={describe(lane, block)}
                      onClick={() =>
                        onSelect(selectedId === task.id ? null : task.id)
                      }
                      className={cn(
                        "flock-lane-block absolute top-1/2 min-w-1.5 -translate-y-1/2 overflow-hidden outline-none transition-[left,width,background-color] duration-1000 ease-linear animate-in fade-in-0 focus-visible:ring-2 focus-visible:ring-ring",
                        block.agentTurn
                          ? "h-2.5 rounded-full"
                          : "h-3.5 rounded-[5px]",
                        BLOCK_TONE[task.state],
                        clipped && "flock-lane-clipped rounded-l-none",
                        selectedId === task.id &&
                          "ring-2 ring-foreground/80 ring-offset-0",
                      )}
                      style={{
                        left: `${left}%`,
                        width: `${Math.max(0, right - left)}%`,
                      }}
                    >
                      {task.state === "running" ? (
                        <>
                          <span
                            aria-hidden="true"
                            className="flock-lane-shine absolute inset-0"
                            data-animated={motion}
                          />
                          <span
                            aria-hidden="true"
                            className="flock-lane-tip absolute inset-y-0 right-0 w-0.5 bg-info"
                            data-animated={motion}
                          />
                        </>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      <ul className="shrink-0 pt-5">
        {lanes.map((lane) => {
          const head = laneHead(lane);
          const live = isLaneLive(lane);
          const stop = head && live ? stopOf(head.task) : undefined;
          const time = head ? taskTime(head.task, now) : null;
          const pending =
            lane.kind === "wakeups" && !live && wakeup && wakeup.at > now
              ? wakeup
              : undefined;
          const flag =
            head &&
            (head.task.state === "paused" ||
              head.task.state === "failed" ||
              head.task.state === "stopped" ||
              head.task.state === "interrupted")
              ? t(`backgroundTasks.flag.${head.task.state}`)
              : undefined;
          return (
            <li
              key={lane.key}
              className="flex h-7 items-center justify-end gap-1.5 whitespace-nowrap text-muted-foreground"
            >
              {stop ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xxs"
                  className="shrink-0"
                  disabled={stop.disabled}
                  onClick={stop.run}
                >
                  {t("backgroundTasks.stop")}
                </Button>
              ) : null}
              {pending ? (
                <span
                  data-testid="background-task-next-in"
                  className="flex items-center gap-1 tabular-nums"
                  title={[
                    t("backgroundTasks.nextAt", {
                      time: clockTime(pending.at),
                    }),
                    pending.reason,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  <FlockDart className="h-2.5 w-3" />
                  {t("backgroundTasks.nextIn", {
                    time: timeUntil(pending.at, now),
                  })}
                </span>
              ) : (
                <>
                  {flag && head ? (
                    <span className={STATE_TONE[head.task.state]}>{flag}</span>
                  ) : null}
                  {time ? (
                    <span
                      className={cn(
                        "tabular-nums",
                        head?.task.state === "running" &&
                          "flock-readout-accent",
                      )}
                    >
                      {time}
                    </span>
                  ) : null}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
