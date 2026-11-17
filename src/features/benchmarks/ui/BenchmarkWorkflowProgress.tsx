import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { IconActivity, IconClock, IconAlertCircle } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import { benchmarkApi } from "../api/benchmarks";
import { benchmarkKeys, useBenchmarkDefinitions } from "../hooks/useBenchmarks";
import { useBenchmarkSessionActivity } from "../hooks/useBenchmarkSessionActivity";
import { explicitEffort } from "../lib/benchmarkEffort";
import { modelDisplayName, stateLabel } from "../lib/benchmarkLabels";
import type {
  Attempt,
  RunSummary,
  WorkflowActivity,
  WorkflowActivityStep,
} from "../types";
import { compactElapsed } from "./BenchmarkTaskGrid";
import {
  FAILING_OUTCOMES,
  RepetitionDots,
  type DotState,
} from "./BenchmarkTestStatus";

function useClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** An event this recent means the chat is at work right now. */
const FRESH_MS = 15_000;

/** What a session's chat was last seen doing, and how to say it. */
function useSessionObservation(sessionId: string) {
  const { t } = useTranslation("benchmarks");
  const query = useBenchmarkSessionActivity(sessionId);
  const now = useClock();
  const observation = query.data;
  const stale = observation && now - observation.checkedAt > 20_000;
  const quiet = Boolean(
    observation && now - observation.unchangedSince >= 300_000,
  );
  const unavailable = Boolean(query.isError || stale);
  const elapsed = observation
    ? compactElapsed(
        now - (observation.activitySeenAt ?? observation.unchangedSince),
      )
    : null;
  const label = unavailable
    ? t("activity.checkUnavailable")
    : !observation
      ? t("activity.checking")
      : t(
          observation.activitySeenAt == null
            ? "activity.observing"
            : "activity.lastSeen",
          { elapsed },
        );
  return {
    label,
    hint:
      quiet && !unavailable ? `${label}. ${t("activity.quietHint")}` : label,
    unavailable,
    quiet,
    elapsed,
    fresh:
      !unavailable &&
      observation?.activitySeenAt != null &&
      now - observation.activitySeenAt < FRESH_MS,
  };
}

function SessionActivity({ sessionId }: { sessionId: string }) {
  const seen = useSessionObservation(sessionId);
  return (
    <span
      role="img"
      aria-label={seen.label}
      title={seen.hint}
      className={cn(
        "inline-flex items-center gap-1 tabular-nums",
        seen.quiet || seen.unavailable
          ? "text-warning"
          : "text-muted-foreground",
      )}
    >
      {seen.unavailable ? (
        <IconAlertCircle aria-hidden className="size-3.5" />
      ) : (
        <IconActivity aria-hidden className="size-3.5" />
      )}
      <span aria-hidden>{seen.unavailable ? "–" : (seen.elapsed ?? "–")}</span>
    </span>
  );
}

/**
 * The same observation in a word, for the strip: at work, idle for so long,
 * or no signal. A chat quiet for five minutes takes the warning tone; that
 * is a reason to look, not proof of a hang.
 */
function SessionPulse({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("benchmarks");
  const seen = useSessionObservation(sessionId);
  return (
    <span
      role="img"
      aria-label={seen.label}
      title={seen.hint}
      className={cn(
        "inline-flex min-w-[5.5rem] items-center gap-1 tabular-nums",
        seen.quiet || seen.unavailable
          ? "text-warning"
          : seen.fresh
            ? "text-info"
            : "text-muted-foreground",
      )}
    >
      {seen.unavailable ? (
        <IconAlertCircle aria-hidden className="size-3.5" />
      ) : (
        <IconActivity
          aria-hidden
          className={cn("size-3.5", seen.fresh && "animate-pulse")}
        />
      )}
      <span aria-hidden>
        {seen.unavailable
          ? t("activity.noSignal")
          : seen.elapsed == null
            ? "…"
            : seen.fresh
              ? t("activity.live")
              : t("activity.idle", { elapsed: seen.elapsed })}
      </span>
    </span>
  );
}

function WorkflowAttemptProgress({
  root,
  totalSteps,
  title,
  taskName,
}: {
  root: Attempt;
  totalSteps?: number;
  title?: string;
  taskName?: string;
}) {
  const { t } = useTranslation("benchmarks");
  const trace = useQuery({
    queryKey: [...benchmarkKeys, "workflow-progress", root.id],
    queryFn: async () => {
      const value = await benchmarkApi.getWorkflowTrace(root.id);
      // Cache only the progress fields, never prompts, outputs or task fixtures.
      return value.steps.map(({ index, attempt }) => ({
        attemptId: attempt.id,
        index,
        phase: attempt.phase,
        outcome: attempt.outcome,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
        sessionId: attempt.sessionId,
        hostRunId: attempt.hostRunId,
        configuration: attempt.observed ?? attempt.configuration,
      }));
    },
    refetchInterval: root.phase === "terminal" ? false : 5000,
    // Native work continues when the desktop window loses focus.
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    staleTime: 4000,
    retry: false,
  });
  if (trace.isError)
    return (
      <span className="text-xs text-muted-foreground">
        {t("activity.checkUnavailable")}
      </span>
    );
  return (
    <WorkflowProgress
      root={root}
      steps={trace.data ?? []}
      totalSteps={totalSteps}
      title={title}
      taskName={taskName}
    />
  );
}

type Translate = ReturnType<typeof useTranslation>["t"];

/** Where an attempt stands: its phase, its verdict so far and its step at work. */
function readProgress(
  t: Translate,
  root: Pick<Attempt, "phase" | "outcome">,
  steps: WorkflowActivityStep[],
  totalSteps: number | undefined,
  now: number,
) {
  const settled = steps.filter((step) => step.phase === "terminal").length;
  const current = steps.find((step) => step.phase !== "terminal");
  const total = totalSteps ?? null;
  const phase =
    current?.phase ??
    (root.phase === "terminal"
      ? root.outcome
      : total != null && settled === total
        ? "grading"
        : root.phase);
  // The dot is the whole attempt's verdict. A completed internal step has
  // no independent grade and must not be presented as a passed test.
  const dot: DotState =
    root.outcome === "pending_review"
      ? "running"
      : root.phase === "terminal"
        ? root.outcome === "pass"
          ? "passed"
          : root.outcome != null && FAILING_OUTCOMES.has(root.outcome)
            ? "failed"
            : "stopped"
        : steps.some(
              (step) => step.hostRunId != null || step.phase === "terminal",
            )
          ? "running"
          : "queued";
  const shownStep = current ?? steps.at(-1);
  const duration =
    shownStep?.startedAt == null
      ? null
      : compactElapsed((shownStep.finishedAt ?? now) - shownStep.startedAt);
  const stepLabel =
    total != null
      ? t("activity.stepOf", {
          number: (current?.index ?? Math.max(0, settled - 1)) + 1,
          total,
        })
      : t("activity.step", { number: (current?.index ?? 0) + 1 });
  return {
    phase,
    dot,
    current,
    shownStep,
    duration,
    stepCount: total ?? steps.length,
    stepStatus: t("activity.stepStatus", {
      step: stepLabel,
      status: stateLabel(t, phase),
    }),
  };
}

/** How one step of a workflow stands, for the mark that draws it. */
function stepStanding(step: WorkflowActivityStep | undefined) {
  const done = step?.phase === "terminal";
  const complete = done && ["completed", "pass"].includes(step?.outcome ?? "");
  const stopped =
    done && (step?.outcome === "cancelled" || step?.outcome == null);
  const failed =
    done && !complete && !stopped && step?.outcome !== "pending_review";
  const working =
    (!done && step?.hostRunId != null) || step?.outcome === "pending_review";
  return {
    state: done ? step.outcome : (step?.phase ?? "pending"),
    tone: complete
      ? ("success" as const)
      : failed
        ? ("destructive" as const)
        : working
          ? ("info" as const)
          : ("muted" as const),
  };
}

/** The chat of the step at work, when it has one worth watching for events. */
function watchedSession(
  current: WorkflowActivityStep | undefined,
  summaryOnly: boolean,
): string | null {
  return current?.sessionId &&
    current.hostRunId &&
    (!summaryOnly ||
      ["preparing", "dispatching", "running", "collecting"].includes(
        current.phase,
      ))
    ? current.sessionId
    : null;
}

/** Shared rendering; the caller chooses the trace or summary read model. */
function WorkflowProgress({
  root,
  steps,
  totalSteps,
  title,
  taskName,
  summaryOnly = false,
}: {
  root: Pick<Attempt, "phase" | "outcome">;
  steps: WorkflowActivityStep[];
  totalSteps?: number;
  title?: string;
  taskName?: string;
  summaryOnly?: boolean;
}) {
  const { t } = useTranslation("benchmarks");
  const now = useClock();
  const { phase, dot, current, shownStep, duration, stepCount, stepStatus } =
    readProgress(t, root, steps, totalSteps, now);
  const configuration = shownStep?.configuration;
  const effort = explicitEffort(configuration?.effort);
  const session = watchedSession(current, summaryOnly);
  return (
    <span className="flex min-w-0 flex-col gap-2 text-xs">
      <span className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium" title={taskName}>
          {title ?? stateLabel(t, phase)}
        </span>
        <span title={stateLabel(t, phase)}>
          <RepetitionDots states={[dot]} />
        </span>
      </span>
      {configuration ? (
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <span className="shrink-0">
            {getProviderIcon(configuration.providerId, "size-3.5")}
          </span>
          <span className="truncate">{modelDisplayName(configuration)}</span>
          {effort ? <span className="ml-auto shrink-0">{effort}</span> : null}
        </span>
      ) : null}
      <span className="flex items-center justify-between gap-3 text-muted-foreground">
        <span
          className="inline-flex items-center gap-1 tabular-nums"
          title={
            duration
              ? t("activity.elapsed", { elapsed: duration })
              : t("unknown")
          }
        >
          <IconClock aria-hidden className="size-3.5" />
          {duration ?? "–"}
        </span>
        {session ? (
          <SessionActivity
            key={summaryOnly ? current?.attemptId : undefined}
            sessionId={session}
          />
        ) : null}
        {stepCount > 0 ? (
          <svg
            role="img"
            aria-label={stepStatus}
            width={stepCount * 12}
            height={stepCount * 4 + 4}
            viewBox={`0 0 ${stepCount * 12} ${stepCount * 4 + 4}`}
            className="max-h-6 max-w-24 shrink-0"
          >
            <title>{stepStatus}</title>
            {Array.from({ length: stepCount }, (_, index) => {
              const { state, tone } = stepStanding(
                steps.find((entry) => entry.index === index),
              );
              return (
                <rect
                  // biome-ignore lint/suspicious/noArrayIndexKey: the workflow step index is its position
                  key={index}
                  x={index * 12}
                  y={(stepCount - index - 1) * 4}
                  width="10"
                  height="5"
                  rx="1"
                  className={cn(
                    tone === "success"
                      ? "fill-success"
                      : tone === "destructive"
                        ? "fill-destructive"
                        : tone === "info"
                          ? "fill-info animate-pulse"
                          : "fill-muted-foreground/40",
                  )}
                >
                  <title>
                    {t("activity.stepStatus", {
                      step: t("activity.step", { number: index + 1 }),
                      status: stateLabel(t, state),
                    })}
                  </title>
                </rect>
              );
            })}
          </svg>
        ) : null}
      </span>
    </span>
  );
}

/**
 * One running repetition of a test on the strip, in a line: which
 * repetition, its steps as marks, how long the step at work has taken, and
 * whether its chat still gets events.
 */
function AttemptChip({
  root,
  totalSteps,
}: {
  root: WorkflowActivity;
  totalSteps?: number;
}) {
  const { t } = useTranslation("benchmarks");
  const now = useClock();
  const { phase, dot, current, duration, stepCount, stepStatus } = readProgress(
    t,
    root,
    root.steps,
    totalSteps,
    now,
  );
  const session = watchedSession(current, true);
  return (
    <span className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap">
      <span
        className="inline-flex items-center gap-1.5"
        title={
          root.repetition == null
            ? stateLabel(t, phase)
            : t("fields.repetitionValue", { value: root.repetition })
        }
      >
        <RepetitionDots states={[dot]} />
        {root.repetition == null ? null : (
          <span className="tabular-nums">
            {t("activity.rep", { value: root.repetition })}
          </span>
        )}
      </span>
      {stepCount > 0 ? (
        <span
          role="img"
          aria-label={stepStatus}
          title={stepStatus}
          className="inline-flex items-center gap-0.5"
        >
          {Array.from({ length: stepCount }, (_, index) => {
            const { tone } = stepStanding(
              root.steps.find((entry) => entry.index === index),
            );
            return (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: the workflow step index is its position
                key={index}
                className={cn(
                  "h-1 w-2.5 rounded-full",
                  tone === "success"
                    ? "bg-success"
                    : tone === "destructive"
                      ? "bg-destructive"
                      : tone === "info"
                        ? "animate-pulse bg-info"
                        : "bg-muted-foreground/35",
                )}
              />
            );
          })}
        </span>
      ) : null}
      {duration ? (
        <span
          className="inline-flex min-w-14 items-center gap-1 tabular-nums"
          title={t("activity.elapsed", { elapsed: duration })}
        >
          <IconClock aria-hidden className="size-3.5" />
          {duration}
        </span>
      ) : null}
      {session ? (
        <SessionPulse key={current?.attemptId} sessionId={session} />
      ) : null}
    </span>
  );
}

/** The tests one run names on the strip before the rest are counted. */
const STRIP_TESTS = 3;

/** Ordinary mixed runs use only entered workflow metadata from list-runs. */
export function BenchmarkWorkflowActivity({
  run,
  compact = false,
}: {
  run: RunSummary;
  compact?: boolean;
}) {
  const { t } = useTranslation("benchmarks");
  const definitions = useBenchmarkDefinitions();
  // Observe the existing coalesced list query's failure without another fetch
  // or per-workflow polling loop. Cached progress is not proof of availability.
  const summaries = useQuery({
    queryKey: [...benchmarkKeys, "runs"],
    queryFn: benchmarkApi.listRuns,
    enabled: false,
  });
  const versions = useMemo(
    () =>
      new Map(
        (definitions.data ?? []).flatMap((definition) =>
          definition.versions.map((version) => [version.id, version.manifest]),
        ),
      ),
    [definitions.data],
  );
  if (
    !["running", "pausing", "cancelling", "needs_attention"].includes(run.state)
  )
    return null;
  if (summaries.isError)
    return (
      <span className="text-xs text-muted-foreground">
        {t("activity.checkUnavailable")}
      </span>
    );
  const roots = (run.workflowActivity ?? []).filter((root) =>
    ["preparing", "dispatching", "running", "collecting"].includes(root.phase),
  );
  if (!compact) {
    if (roots.length === 0) return null;
    return (
      <span className="flex min-w-0 flex-col gap-2">
        <span className="grid max-h-60 grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-3 overflow-y-auto">
          {roots.map((root) => {
            const manifest = versions.get(root.versionId);
            return (
              <WorkflowProgress
                key={root.rootAttemptId}
                root={root}
                steps={root.steps}
                totalSteps={manifest?.workflow?.steps.length}
                title={manifest?.name}
                summaryOnly
              />
            );
          })}
        </span>
      </span>
    );
  }
  // The strip: a line per test, its running repetitions beside its name.
  // A test running with no workflow to report (a single turn, or one whose
  // answer awaits its judges) is named too, so the run says all it is doing.
  const shown = roots.slice(0, STRIP_TESTS);
  const groups = new Map<string, WorkflowActivity[]>();
  for (const root of shown) {
    const group = groups.get(root.versionId) ?? [];
    group.push(root);
    groups.set(root.versionId, group);
  }
  const entered = new Set(roots.map((root) => root.versionId));
  const plain = [
    ...new Set(
      (run.openCells ?? [])
        .filter((cell) => cell.running && !entered.has(cell.versionId))
        .map((cell) => cell.versionId),
    ),
  ];
  const shownPlain = plain.slice(0, Math.max(0, STRIP_TESTS - groups.size));
  const hidden = roots.length - shown.length + plain.length - shownPlain.length;
  if (roots.length === 0 && plain.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-col gap-1 border-l border-border pl-3 text-xs text-muted-foreground">
      {[...groups].map(([versionId, attempts]) => (
        <span
          key={versionId}
          className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1"
        >
          <span
            className="min-w-0 flex-[1_1_12rem] truncate text-sm text-foreground"
            title={versions.get(versionId)?.name}
          >
            {versions.get(versionId)?.name ?? t("activity.workflowTask")}
          </span>
          <span className="flex flex-wrap items-center justify-end gap-x-5 gap-y-1">
            {[...attempts]
              .sort((a, b) => (a.repetition ?? 0) - (b.repetition ?? 0))
              .map((root) => (
                <AttemptChip
                  key={root.rootAttemptId}
                  root={root}
                  totalSteps={versions.get(versionId)?.workflow?.steps.length}
                />
              ))}
          </span>
        </span>
      ))}
      {shownPlain.map((versionId) => (
        <span key={versionId} className="flex min-w-0 items-center gap-x-5">
          <span
            className="min-w-0 flex-1 truncate text-sm text-foreground"
            title={versions.get(versionId)?.name}
          >
            {versions.get(versionId)?.name ?? t("activity.test")}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1.5">
            <RepetitionDots states={["running"]} />
            {stateLabel(t, "running")}
          </span>
        </span>
      ))}
      {hidden > 0 ? <span>{t("activity.more", { count: hidden })}</span> : null}
    </span>
  );
}

/** Shared by the active run strip and its drawer; all operations are read-only. */
export function BenchmarkWorkflowProgress({
  runId,
  title,
}: {
  runId: string;
  title?: string;
}) {
  const { t } = useTranslation("benchmarks");
  const definitions = useBenchmarkDefinitions();
  const run = useQuery({
    queryKey: [...benchmarkKeys, "run", runId],
    queryFn: () => benchmarkApi.getRun(runId),
    refetchInterval: (query) =>
      ["running", "pausing", "cancelling"].includes(
        query.state.data?.state ?? "",
      )
        ? 5000
        : false,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    staleTime: 4000,
    retry: false,
  });
  if (run.isError)
    return (
      <span className="text-xs text-muted-foreground">
        {t("activity.checkUnavailable")}
      </span>
    );
  if (!run.data)
    return (
      <span className="text-xs text-muted-foreground">
        {t("activity.checking")}
      </span>
    );
  return (
    <span className="flex flex-col gap-2">
      {run.data.attempts
        .filter((attempt) => attempt.outcome !== "superseded")
        .map((root) => (
          <WorkflowAttemptProgress
            key={root.id}
            root={root}
            title={title}
            taskName={
              definitions.data
                ?.flatMap((definition) => definition.versions)
                .find((version) => version.id === root.versionId)?.manifest.name
            }
            totalSteps={
              definitions.data
                ?.flatMap((definition) => definition.versions)
                .find((version) => version.id === root.versionId)?.manifest
                .workflow?.steps.length
            }
          />
        ))}
    </span>
  );
}
