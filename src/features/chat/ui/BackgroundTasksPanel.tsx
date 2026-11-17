import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Clock, FolderOpen, X } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { getClient } from "@/shared/api/acpConnection";
import { cn } from "@/shared/lib/cn";
import { revealInFileManager } from "@/shared/lib/fileManager";
import { useWorkingIndicatorAnimationPreference } from "@/shared/preferences/workingIndicatorAnimationPreference";
import { Button } from "@/shared/ui/button";
import { CollapseReveal } from "@/shared/ui/collapse-reveal";
import { ActiveChatPulseDot } from "@/shared/ui/SessionActivityIndicator";
import { useRunningClock } from "../hooks/useRunningClock";
import {
  buildTaskLanes,
  fitTimelineSpan,
  formatAxisDistance,
  type LaneBlock,
  latestScheduledWakeup,
  type PendingWakeup,
  type TaskLane,
} from "../lib/backgroundTaskLanes";
import {
  type BackgroundTask,
  type BackgroundTaskState,
  EMPTY_BACKGROUND_TASKS,
  isBackgroundTaskLive,
  NO_DISMISSED_BACKGROUND_TASKS,
  useBackgroundTasksStore,
} from "../stores/backgroundTasksStore";
import { useChatStore } from "../stores/chatStore";
import {
  BackgroundTaskTimeline,
  clockTime,
  STATE_TONE,
  StateIcon,
  taskTime,
  timeUntil,
} from "./BackgroundTaskTimeline";

/** The order the header counts the states in: what needs a look comes first. */
const COUNTED_STATES: readonly BackgroundTaskState[] = [
  "running",
  "paused",
  "failed",
  "interrupted",
  "stopped",
  "completed",
];

const MINUTE = 60_000;
/** The spans the operator can step through; `null` fits what is running. */
const SPAN_CHOICES: readonly (number | null)[] = [
  null,
  15 * MINUTE,
  60 * MINUTE,
  6 * 60 * MINUTE,
  24 * 60 * MINUTE,
];

/** What one run was: opened by picking its block on the timeline. */
function RunDetail({
  lane,
  block,
  title,
  now,
  onClose,
  onShowOutput,
}: {
  lane: TaskLane;
  block: LaneBlock;
  title: string;
  now: number;
  onClose: () => void;
  onShowOutput?: (path: string) => void;
}) {
  const { t } = useTranslation("chat");
  const { task } = block;
  const time = taskTime(task, now);
  const when =
    task.startedAt === undefined
      ? null
      : task.endedAt === undefined
        ? t("backgroundTasks.since", { time: clockTime(task.startedAt) })
        : `${clockTime(task.startedAt)} – ${clockTime(task.endedAt)}`;
  // A turn over a command's result says which result; a wake-up's cause is
  // its lane, and the bridge's wording of it is a timestamp.
  const cause =
    block.agentTurn && lane.kind !== "wakeups" ? task.description : undefined;
  const output = onShowOutput ? task.outputFilePath : undefined;
  return (
    <div
      className="space-y-1 border-t border-border px-3 py-2 text-xs"
      data-role="background-task-detail"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex w-4 shrink-0 items-center justify-center">
          <StateIcon state={task.state} />
        </span>
        <span className="min-w-0 truncate text-sm" title={title}>
          {title}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 tabular-nums text-muted-foreground">
          <span className={STATE_TONE[task.state]}>
            {t(`backgroundTasks.${task.state}`)}
          </span>
          {[when, time].filter(Boolean).map((part) => (
            <span key={part} className="flex items-center gap-1.5">
              <span className="opacity-50">{"·"}</span>
              {part}
            </span>
          ))}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xxs"
          className="ml-auto shrink-0"
          aria-label={t("backgroundTasks.closeDetail")}
          title={t("backgroundTasks.closeDetail")}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      {cause ? (
        <p className="break-words pl-6 text-muted-foreground">{cause}</p>
      ) : null}
      {task.summary ? (
        <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words pl-6">
          {task.summary}
        </p>
      ) : null}
      {output ? (
        <div className="pl-6">
          <Button
            type="button"
            variant="ghost"
            flush
            size="xxs"
            className="max-w-full justify-start"
            leftIcon={<FolderOpen aria-hidden="true" />}
            title={output}
            onClick={() => onShowOutput?.(output)}
          >
            <span className="truncate">{t("backgroundTasks.showOutput")}</span>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The work a chat left running behind its answers, as one tray over the
 * composer: a header that counts it by state and says when the agent wakes
 * next, and under it a timeline with a lane for each piece of work. What
 * still runs can be stopped from its lane; a block opens onto what its run
 * was.
 */
export function BackgroundTaskList({
  tasks,
  wakeup,
  onStop,
  onClear,
  onShowOutput,
  className,
}: {
  tasks: readonly BackgroundTask[];
  /** The wake-up the agent last scheduled for itself, fired or not. */
  wakeup?: PendingWakeup | null;
  /** Asks the agent to stop a task; rejects when the request did not go through. */
  onStop: (id: string) => Promise<void>;
  /** Takes the ended tasks off the list. Omit and they cannot be cleared. */
  onClear?: () => void;
  /** Shows a task's output file; rejects when it cannot be shown. */
  onShowOutput?: (path: string) => Promise<void>;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const listId = useId();
  const reducedMotion = useReducedMotion();
  const animationPreference = useWorkingIndicatorAnimationPreference();
  const liveCount = tasks.filter(isBackgroundTaskLive).length;
  const hasLive = liveCount > 0;
  // Open while something runs and folded once it has all ended; what the
  // operator chose instead holds until that changes again.
  const [choice, setChoice] = useState<{ live: boolean; open: boolean }>();
  const open = choice && choice.live === hasLive ? choice.open : hasLive;
  const [spanChoice, setSpanChoice] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<"stop" | "output" | null>(null);
  // The timeline ends at now, and the header counts down to the next wake-up.
  const now = useRunningClock(
    open || (wakeup != null && wakeup.at > Date.now()),
  );
  const pending = wakeup && wakeup.at > now ? wakeup : null;
  const lanes = useMemo(() => {
    const built = buildTaskLanes(tasks);
    // A wake-up scheduled before any has fired still has its lane.
    return pending && !built.some((lane) => lane.kind === "wakeups")
      ? [
          ...built,
          { key: "wakeups", kind: "wakeups", blocks: [] } satisfies TaskLane,
        ]
      : built;
  }, [tasks, pending]);
  if (tasks.length === 0 && !pending) return null;

  const span = SPAN_CHOICES[spanChoice] ?? fitTimelineSpan(lanes, now);
  const counts = COUNTED_STATES.flatMap((state) => {
    const count = tasks.filter((task) => task.state === state).length;
    return count > 0
      ? [{ state, text: t(`backgroundTasks.count.${state}`, { count }) }]
      : [];
  });
  const worst = tasks.some((task) => task.state === "failed")
    ? "failed"
    : tasks.some((task) => task.state === "interrupted")
      ? "interrupted"
      : "completed";
  const selected = lanes
    .flatMap((lane) => lane.blocks.map((block) => ({ lane, block })))
    .find(({ block }) => block.task.id === selectedId);
  const stop = async (id: string) => {
    setStopping(id);
    setError(null);
    try {
      await onStop(id);
    } catch {
      setError("stop");
    } finally {
      setStopping(null);
    }
  };
  const showOutput = onShowOutput
    ? (path: string) => {
        setError(null);
        void onShowOutput(path).catch(() => setError("output"));
      }
    : undefined;
  const notes = [
    ...counts.map((part) => (
      <span key={part.state} className={STATE_TONE[part.state]}>
        {part.text}
      </span>
    )),
    ...(pending
      ? [
          <span
            key="wakeup"
            data-testid="background-tasks-next-wakeup"
            title={[
              t("backgroundTasks.nextAt", { time: clockTime(pending.at) }),
              pending.reason,
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            {t("backgroundTasks.nextWakeup", {
              time: timeUntil(pending.at, now),
            })}
          </span>,
        ]
      : []),
  ];

  return (
    <section
      aria-label={t("backgroundTasks.history")}
      className={cn(
        "mb-2 overflow-hidden rounded-sm bg-surface-composer text-sm ring-1 ring-input backdrop-blur-md",
        className,
      )}
      data-role="background-tasks"
    >
      <div className="flex h-9 items-center gap-1 pl-3 pr-1.5">
        <Button
          type="button"
          variant="ghost"
          flush
          size="sm"
          className="flex h-full min-w-0 flex-1 justify-start gap-2 px-0 text-left"
          aria-expanded={open}
          aria-controls={listId}
          data-testid="background-tasks-toggle"
          onClick={() => setChoice({ live: hasLive, open: !open })}
          rightIcon={
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 transition-transform",
                open && "rotate-90",
              )}
            />
          }
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            {hasLive ? (
              <ActiveChatPulseDot />
            ) : tasks.length === 0 ? (
              <Clock
                aria-hidden="true"
                className="size-3.5 text-muted-foreground"
              />
            ) : (
              <StateIcon state={worst} />
            )}
          </span>
          <span className="shrink-0 text-sm font-medium text-foreground">
            {t("backgroundTasks.history")}
          </span>
          <span className="min-w-0 truncate text-xs font-normal tabular-nums">
            {notes.map((note, index) => (
              <span key={note.key}>
                {index > 0 ? " · " : null}
                {note}
              </span>
            ))}
          </span>
        </Button>
        {open ? (
          <Button
            type="button"
            variant="ghost"
            flush
            size="xxs"
            className="mr-1 shrink-0"
            data-testid="background-tasks-span"
            title={t("backgroundTasks.spanHint")}
            onClick={() =>
              setSpanChoice((current) => (current + 1) % SPAN_CHOICES.length)
            }
          >
            {t("backgroundTasks.last", { span: formatAxisDistance(span) })}
          </Button>
        ) : null}
        {onClear && liveCount < tasks.length ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xxs"
            className="shrink-0"
            aria-label={t("backgroundTasks.clear")}
            title={t("backgroundTasks.clear")}
            onClick={onClear}
          >
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <CollapseReveal open={open} id={listId}>
        <div className="max-h-[min(40vh,15rem)] overflow-y-auto overscroll-contain border-t border-border">
          <BackgroundTaskTimeline
            lanes={lanes}
            now={now}
            span={span}
            wakeup={pending}
            animated={animationPreference.enabled && !reducedMotion}
            selectedId={selected ? selectedId : null}
            onSelect={setSelectedId}
            stopOf={(task) =>
              task.canStop
                ? { disabled: stopping !== null, run: () => void stop(task.id) }
                : undefined
            }
          />
        </div>
        {selected ? (
          <RunDetail
            lane={selected.lane}
            block={selected.block}
            title={
              selected.lane.kind === "wakeups"
                ? t("backgroundTasks.lanes.wakeups")
                : selected.block.agentTurn
                  ? t("backgroundTasks.agentTurn")
                  : (selected.lane.title ?? t("backgroundTasks.task"))
            }
            now={now}
            onClose={() => setSelectedId(null)}
            onShowOutput={showOutput}
          />
        ) : null}
        {error ? (
          <p role="alert" className="px-3 pb-2 text-xs text-destructive">
            {t(
              error === "stop"
                ? "backgroundTasks.stopFailed"
                : "backgroundTasks.showOutputFailed",
            )}
          </p>
        ) : null}
      </CollapseReveal>
    </section>
  );
}

/** Session work outlives an individual answer and its collapsed step group. */
export function BackgroundTasksPanel({ sessionId }: { sessionId: string }) {
  const tasks = useBackgroundTasksStore(
    (state) => state.bySession[sessionId] ?? EMPTY_BACKGROUND_TASKS,
  );
  const dismissed = useBackgroundTasksStore(
    (state) =>
      state.dismissedBySession[sessionId] ?? NO_DISMISSED_BACKGROUND_TASKS,
  );
  const dismissEnded = useBackgroundTasksStore((state) => state.dismissEnded);
  // Read as one string: the transcript changes with every streamed piece,
  // the wake-up scheduled in it almost never.
  const scheduled = useChatStore((state) => {
    const wakeup = latestScheduledWakeup(state.messagesBySession[sessionId]);
    return wakeup ? `${wakeup.at}\n${wakeup.reason ?? ""}` : "";
  });
  const wakeup = useMemo<PendingWakeup | null>(() => {
    if (!scheduled) return null;
    const cut = scheduled.indexOf("\n");
    const reason = scheduled.slice(cut + 1);
    return {
      at: Number(scheduled.slice(0, cut)),
      ...(reason ? { reason } : {}),
    };
  }, [scheduled]);
  const shown = useMemo(
    () =>
      dismissed.length === 0
        ? tasks
        : tasks.filter(
            (task) =>
              isBackgroundTaskLive(task) || !dismissed.includes(task.id),
          ),
    [tasks, dismissed],
  );
  return (
    <BackgroundTaskList
      // One chat's folds and picked runs are not the next chat's.
      key={sessionId}
      tasks={shown}
      wakeup={wakeup}
      onStop={async (id) => {
        const client = await getClient();
        await client.extMethod("_session/async_task/stop", {
          sessionId,
          asyncTaskId: id,
        });
      }}
      onClear={() => dismissEnded(sessionId)}
      onShowOutput={revealInFileManager}
    />
  );
}
