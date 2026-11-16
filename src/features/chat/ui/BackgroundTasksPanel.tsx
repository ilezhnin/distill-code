import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CirclePause,
  CircleStop,
  CircleX,
  FolderOpen,
  X,
} from "lucide-react";
import { getClient } from "@/shared/api/acpConnection";
import { cn } from "@/shared/lib/cn";
import { revealInFileManager } from "@/shared/lib/fileManager";
import { Button } from "@/shared/ui/button";
import { CollapseReveal } from "@/shared/ui/collapse-reveal";
import { ActiveChatPulseDot } from "@/shared/ui/SessionActivityIndicator";
import { Spinner } from "@/shared/ui/spinner";
import { useRunningClock } from "../hooks/useRunningClock";
import {
  type BackgroundTask,
  type BackgroundTaskState,
  EMPTY_BACKGROUND_TASKS,
  isBackgroundTaskLive,
  NO_DISMISSED_BACKGROUND_TASKS,
  orderBackgroundTasks,
  useBackgroundTasksStore,
} from "../stores/backgroundTasksStore";
import { formatWorkingTime } from "./LoadingFlock";

/** The order the header counts the states in: what needs a look comes first. */
const COUNTED_STATES: readonly BackgroundTaskState[] = [
  "running",
  "paused",
  "failed",
  "interrupted",
  "stopped",
  "completed",
];

/** The tone a state's count and word take; the ordinary ones take none. */
const STATE_TONE: Partial<Record<BackgroundTaskState, string>> = {
  failed: "text-destructive",
  interrupted: "text-warning",
};

function StateIcon({ state }: { state: BackgroundTaskState }) {
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
function taskTime(task: BackgroundTask, now: number): string | null {
  if (task.startedAt === undefined) return null;
  const end = isBackgroundTaskLive(task) ? now : task.endedAt;
  if (end === undefined) return null;
  const seconds = (end - task.startedAt) / 1000;
  return seconds >= 1 ? formatWorkingTime(seconds) : null;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

function TaskRow({
  task,
  now,
  expanded,
  onToggle,
  stop,
  onShowOutput,
}: {
  task: BackgroundTask;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  /** The stop control of a task that can be stopped. */
  stop?: { disabled: boolean; run: () => void };
  onShowOutput?: (path: string) => void;
}) {
  const { t } = useTranslation("chat");
  const detailId = useId();
  const title = task.description ?? task.name ?? t("backgroundTasks.task");
  const stateLabel = t(`backgroundTasks.${task.state}`);
  const time = taskTime(task, now);
  // A state that is neither "still going" nor "went fine" is said in words:
  // the long one on a line of its own, the short ones beside the time.
  const note = task.state === "interrupted" ? stateLabel : undefined;
  const flag =
    task.state === "paused" ||
    task.state === "failed" ||
    task.state === "stopped"
      ? stateLabel
      : undefined;
  const output = onShowOutput ? task.outputFilePath : undefined;
  // A row opens only when there is something behind it.
  const expandable = Boolean(task.summary || output);
  const open = expandable && expanded;
  const quiet = task.state === "completed" || task.state === "stopped";
  const titleClass = cn(
    "block leading-5",
    open ? "break-words" : "truncate",
    quiet && "text-muted-foreground",
  );
  return (
    <li data-testid="background-task-row" data-state={task.state}>
      <div
        className={cn(
          "relative flex items-start gap-2 rounded-sm px-1.5 py-1",
          expandable && "hover:bg-[var(--sidebar-row-hover)]",
        )}
      >
        <span
          className="flex h-5 w-4 shrink-0 items-center justify-center"
          title={stateLabel}
        >
          <StateIcon state={task.state} />
        </span>
        <div className="min-w-0 flex-1">
          {expandable ? (
            // The whole row is the button's target; the stop control sits
            // above it.
            <button
              type="button"
              aria-expanded={open}
              aria-controls={detailId}
              onClick={onToggle}
              className={cn(
                titleClass,
                "w-full text-left outline-none after:absolute after:inset-0 after:rounded-sm focus-visible:after:ring-1 focus-visible:after:ring-ring",
              )}
            >
              {title}
            </button>
          ) : (
            <span className={titleClass} title={title}>
              {title}
            </span>
          )}
          <span className="sr-only">{stateLabel}</span>
          {note ? (
            <span className={cn("block text-xs", STATE_TONE[task.state])}>
              {note}
            </span>
          ) : null}
          {task.summary && !open ? (
            <span className="block truncate text-xs text-muted-foreground">
              {firstLine(task.summary)}
            </span>
          ) : null}
        </div>
        {stop ? (
          <Button
            type="button"
            variant="ghost"
            size="xxs"
            className="relative z-10 -my-0.5 shrink-0"
            disabled={stop.disabled}
            onClick={stop.run}
          >
            {t("backgroundTasks.stop")}
          </Button>
        ) : null}
        {flag || time ? (
          <span className="flex h-5 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            {flag ? (
              <span className={STATE_TONE[task.state]}>{flag}</span>
            ) : null}
            {time ? (
              <span
                className={cn(
                  "tabular-nums",
                  task.state === "running" && "flock-readout-accent",
                )}
              >
                {time}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      {expandable ? (
        <CollapseReveal open={open} id={detailId}>
          <div className="space-y-1 pb-1.5 pl-[1.875rem] pr-2 text-xs">
            {task.summary ? (
              <p className="whitespace-pre-wrap break-words">{task.summary}</p>
            ) : null}
            {output ? (
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
                <span className="truncate">
                  {t("backgroundTasks.showOutput")}
                </span>
              </Button>
            ) : null}
          </div>
        </CollapseReveal>
      ) : null}
    </li>
  );
}

/**
 * The work a chat left running behind its answers, as one calm tray over the
 * composer: a header that counts it by state, and a row per task with what it
 * is, how it stands and how long it has taken. What still runs is listed
 * first and can be stopped; a row opens onto its result.
 */
export function BackgroundTaskList({
  tasks,
  onStop,
  onClear,
  onShowOutput,
  className,
}: {
  tasks: readonly BackgroundTask[];
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
  const ordered = useMemo(() => orderBackgroundTasks(tasks), [tasks]);
  const liveCount = ordered.filter(isBackgroundTaskLive).length;
  const hasLive = liveCount > 0;
  // Open while something runs and folded once it has all ended; what the
  // operator chose instead holds until that changes again.
  const [choice, setChoice] = useState<{ live: boolean; open: boolean }>();
  const open = choice && choice.live === hasLive ? choice.open : hasLive;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<"stop" | "output" | null>(null);
  const now = useRunningClock(
    open && ordered.some((task) => isBackgroundTaskLive(task)),
  );
  if (ordered.length === 0) return null;

  const counts = COUNTED_STATES.flatMap((state) => {
    const count = ordered.filter((task) => task.state === state).length;
    return count > 0
      ? [{ state, text: t(`backgroundTasks.count.${state}`, { count }) }]
      : [];
  });
  const worst = ordered.some((task) => task.state === "failed")
    ? "failed"
    : ordered.some((task) => task.state === "interrupted")
      ? "interrupted"
      : "completed";
  const toggleRow = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
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
            {hasLive ? <ActiveChatPulseDot /> : <StateIcon state={worst} />}
          </span>
          <span className="shrink-0 text-sm font-medium text-foreground">
            {t("backgroundTasks.history")}
          </span>
          <span className="min-w-0 truncate text-xs font-normal">
            {counts.map((part, index) => (
              <span key={part.state}>
                {index > 0 ? " · " : null}
                <span className={STATE_TONE[part.state]}>{part.text}</span>
              </span>
            ))}
          </span>
        </Button>
        {onClear && liveCount < ordered.length ? (
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
        <ul className="max-h-[min(40vh,15rem)] space-y-px overflow-y-auto overscroll-contain border-t border-border px-1.5 py-1.5">
          {ordered.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              now={now}
              expanded={expanded.has(task.id)}
              onToggle={() => toggleRow(task.id)}
              onShowOutput={showOutput}
              stop={
                isBackgroundTaskLive(task) && task.canStop
                  ? {
                      disabled: stopping !== null,
                      run: () => void stop(task.id),
                    }
                  : undefined
              }
            />
          ))}
        </ul>
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
      // One chat's folds and open rows are not the next chat's.
      key={sessionId}
      tasks={shown}
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
