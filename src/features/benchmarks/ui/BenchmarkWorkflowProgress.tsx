import { useEffect, useState } from "react";
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
import type { Attempt } from "../types";
import { compactElapsed } from "./BenchmarkTaskGrid";
import { RepetitionDots, type DotState } from "./BenchmarkTestStatus";

function useClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function SessionActivity({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("benchmarks");
  const query = useBenchmarkSessionActivity(sessionId);
  const now = useClock();
  const observation = query.data;
  const stale = observation && now - observation.checkedAt > 20_000;
  const quiet = observation && now - observation.unchangedSince >= 300_000;
  const unavailable = query.isError || stale;
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
  return (
    <span
      role="img"
      aria-label={label}
      title={
        quiet && !unavailable ? `${label}. ${t("activity.quietHint")}` : label
      }
      className={cn(
        "inline-flex items-center gap-1 tabular-nums",
        quiet || unavailable ? "text-warning" : "text-muted-foreground",
      )}
    >
      {unavailable ? (
        <IconAlertCircle aria-hidden className="size-3.5" />
      ) : (
        <IconActivity aria-hidden className="size-3.5" />
      )}
      <span aria-hidden>{unavailable ? "–" : (elapsed ?? "–")}</span>
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
  const now = useClock();
  const trace = useQuery({
    queryKey: [...benchmarkKeys, "workflow-progress", root.id],
    queryFn: async () => {
      const value = await benchmarkApi.getWorkflowTrace(root.id);
      // Cache only the progress fields, never prompts, outputs or task fixtures.
      return value.steps.map(({ index, attempt }) => ({
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
  const steps = trace.data ?? [];
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
          : root.outcome === "cancelled" || root.outcome == null
            ? "stopped"
            : "failed"
        : steps.some(
              (step) => step.hostRunId != null || step.phase === "terminal",
            )
          ? "running"
          : "queued";
  const shownStep = current ?? steps.at(-1);
  const configuration = shownStep?.configuration;
  const effort = explicitEffort(configuration?.effort);
  const duration =
    shownStep?.startedAt == null
      ? null
      : compactElapsed((shownStep.finishedAt ?? now) - shownStep.startedAt);
  const stepCount = total ?? steps.length;
  const stepLabel =
    total != null
      ? t("activity.stepOf", {
          number: (current?.index ?? Math.max(0, settled - 1)) + 1,
          total,
        })
      : t("activity.step", { number: (current?.index ?? 0) + 1 });
  const stepStatus = t("activity.stepStatus", {
    step: stepLabel,
    status: stateLabel(t, phase),
  });
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
        {current?.sessionId && current.hostRunId ? (
          <SessionActivity sessionId={current.sessionId} />
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
              const step = steps.find((entry) => entry.index === index);
              const done = step?.phase === "terminal";
              const state = done ? step.outcome : (step?.phase ?? "pending");
              const complete =
                done && ["completed", "pass"].includes(step?.outcome ?? "");
              const stopped =
                done &&
                (step?.outcome === "cancelled" || step?.outcome == null);
              const failed =
                done &&
                !complete &&
                !stopped &&
                step?.outcome !== "pending_review";
              const working =
                (!done && step?.hostRunId != null) ||
                step?.outcome === "pending_review";
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
                    complete
                      ? "fill-success"
                      : failed
                        ? "fill-destructive"
                        : working
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

/** Shared by the active run strip and its drawer; all operations are read-only. */
export function BenchmarkWorkflowProgress({
  runId,
  showPauseReason = true,
  title,
}: {
  runId: string;
  showPauseReason?: boolean;
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
      {showPauseReason && run.data.state === "pausing" ? (
        <span className="text-xs text-muted-foreground">
          {t("activity.draining")}
        </span>
      ) : null}
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
