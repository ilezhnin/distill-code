// One test's progress as every run view shows it: queued, running with its
// clock, judged, then its repetitions passed of those scored, with a check
// only when every one passed, and the time it took.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconCheck, IconHourglass, IconX } from "@tabler/icons-react";
import { useLocaleFormatting } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { Spinner } from "@/shared/ui/spinner";
import { benchmarkApi } from "../api/benchmarks";
import { formatElapsed, stateLabel } from "../lib/benchmarkLabels";
import type { Attempt, AttemptSummary } from "../types";

/** The attempt fields a status reads; a summary lacks the queue fields. */
export type StatusAttempt = Pick<
  Attempt,
  "id" | "phase" | "outcome" | "finishedAt" | "durationMs"
> & {
  startedAt?: number | null;
  reason?: string | null;
  waitUntil?: number | null;
};

/** Attempt phases between dispatch and a settled answer. */
export const WORKING = new Set([
  "preparing",
  "dispatching",
  "running",
  "collecting",
]);
/** Run states in which attempts still start or finish. */
export const ACTIVE_RUN = new Set(["planned", "running", "pausing"]);
/**
 * The points from which a finished test reads as passed: an objective check
 * scores all or nothing, a judged design anywhere between.
 */
const PASS_POINTS = 500;

/** Whether a score reads as passed, its check rather than its cross. */
export function passed(score: number): boolean {
  return Math.round(score * 1000) >= PASS_POINTS;
}
/** Run states after which no attempt starts. */
export const FINISHED_RUN = new Set(["completed", "cancelled"]);

export type TestStatus =
  | { kind: "queued" }
  | {
      kind: "waiting";
      reason: string;
      stopped: boolean;
      /** When the runner tries the test again, where it knows. */
      until: number | null;
    }
  | { kind: "running"; startedAt: number | null }
  | { kind: "judging"; startedAt: number | null }
  | {
      kind: "scored";
      /** Mean score of the repetitions, 0 to 1. */
      score: number;
      /** Repetitions that passed, of those scored: the case counts at all. */
      passes: number;
      of: number;
      /** A case scored on a scale by a panel: its mean points, no pass. */
      graded: boolean;
      durationMs: number | null;
    }
  | { kind: "unscored"; outcome: string | null; durationMs: number | null };

/**
 * Attempt summaries by id; one listing returns at most 100. With `asOf`, the
 * verdicts that stood at that date.
 */
export async function listByIds(
  ids: readonly string[],
  asOf: number | null = null,
): Promise<AttemptSummary[]> {
  const pages: AttemptSummary[][] = [];
  for (let start = 0; start < ids.length; start += 100) {
    pages.push(
      await benchmarkApi.listAttempts({
        attemptIds: ids.slice(start, start + 100),
        ...(asOf == null ? {} : { asOf }),
        limit: 100,
      }),
    );
  }
  return pages.flat();
}

/** One test's state across its attempts in the run. */
export function testStatus(
  attempts: StatusAttempt[],
  scores: Map<string, number | null>,
  runState: string | null,
  graded = false,
): TestStatus | null {
  if (attempts.length === 0) return null;
  const runFinished = runState != null && FINISHED_RUN.has(runState);
  const working = attempts.find((a) => WORKING.has(a.phase));
  if (working) return { kind: "running", startedAt: working.startedAt ?? null };
  const judging = attempts.find(
    (a) => a.phase === "awaiting_judges" || a.outcome === "pending_review",
  );
  if (judging) return { kind: "judging", startedAt: judging.startedAt ?? null };
  // A test the runner put back in the queue with a reason waits on its
  // provider: a usage limit, a sign-in renewal or the operator.
  const returned = attempts.find((a) => a.phase === "pending" && a.reason);
  if (returned?.reason && !runFinished)
    return {
      kind: "waiting",
      reason: returned.reason,
      // A run that stopped for the operator no longer waits on its own.
      stopped: runState == null || !ACTIVE_RUN.has(runState),
      until: returned.waitUntil ?? null,
    };
  if (attempts.some((a) => a.phase === "pending"))
    return runFinished
      ? { kind: "unscored", outcome: "cancelled", durationMs: null }
      : { kind: "queued" };
  // The same clock the running row showed: from its start to its finish.
  const durations = attempts.flatMap((a) =>
    a.startedAt != null && a.finishedAt != null
      ? [a.finishedAt - a.startedAt]
      : a.durationMs == null
        ? []
        : [a.durationMs],
  );
  const durationMs =
    durations.length > 0
      ? durations.reduce((sum, value) => sum + value, 0) / durations.length
      : null;
  const values = attempts.flatMap((a) => {
    const score = scores.get(a.id);
    return score == null ? [] : [score];
  });
  if (values.length > 0)
    return {
      kind: "scored",
      score: values.reduce((sum, value) => sum + value, 0) / values.length,
      passes: values.filter(passed).length,
      of: values.length,
      graded,
      durationMs,
    };
  return { kind: "unscored", outcome: attempts[0].outcome, durationMs };
}

/**
 * What a returned test waits for, from the reason the runner recorded; with
 * `timed`, the wording that names when the runner tries it again.
 */
function waitingLabel(
  reason: string,
  stopped: boolean,
  timed: boolean,
): string {
  if (/usage limit|quota/i.test(reason)) {
    if (stopped) return "modelRun.stoppedQuota";
    return timed ? "modelRun.waitingQuotaUntil" : "modelRun.waitingQuota";
  }
  if (stopped) return "modelRun.stopped";
  if (/sign-in/i.test(reason))
    return timed ? "modelRun.waitingSignInUntil" : "modelRun.waitingSignIn";
  return "modelRun.waiting";
}

/** Now, ticking every second while `active`, for a running test's clock. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * A test's mark: its clock while it runs, its result and time once done.
 * `compact` leaves the time to the block around it.
 */
export function TestStatusMark({
  status,
  now,
  compact = false,
}: {
  status: TestStatus | null;
  now: number;
  compact?: boolean;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  if (!status) return null;
  const time = (milliseconds: number | null) =>
    milliseconds == null || compact ? null : (
      <span className="text-xs text-muted-foreground tabular-nums">
        {formatElapsed(t, Math.max(0, milliseconds))}
      </span>
    );
  const since = (startedAt: number | null) =>
    startedAt == null ? null : now - startedAt;
  switch (status.kind) {
    case "queued":
      return (
        <span className="shrink-0 text-xs text-muted-foreground">
          {t("modelRun.queued")}
        </span>
      );
    case "waiting": {
      // A time already behind is one the runner is about to act on.
      const until =
        !status.stopped && status.until != null && status.until > now
          ? status.until
          : null;
      return (
        <span
          title={status.reason}
          className="flex shrink-0 items-center gap-1.5 text-xs text-chart-1"
        >
          {t(waitingLabel(status.reason, status.stopped, until != null), {
            time:
              until == null
                ? undefined
                : formatDate(until, { timeStyle: "short" }),
          })}
          <IconHourglass aria-hidden className="size-4" />
        </span>
      );
    }
    case "running":
      return (
        <span className="flex shrink-0 items-center gap-2">
          {time(since(status.startedAt))}
          <Spinner
            aria-label={t("modelRun.running")}
            className="size-4 text-chart-1"
          />
        </span>
      );
    case "judging":
      return (
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {t("modelRun.judging")}
          {time(since(status.startedAt))}
          <Spinner decorative className="size-4" />
        </span>
      );
    case "scored": {
      // A graded case reads as its mean points, as the boards count it.
      if (status.graded)
        return (
          <span className="flex shrink-0 items-center gap-2">
            {time(status.durationMs)}
            <span
              className="text-right text-sm tabular-nums"
              title={t("states.judged")}
            >
              {Math.round(status.score * 1000)}
            </span>
          </span>
        );
      // Every other result reads the same: repetitions passed of those
      // scored, then a check only when all of them did, a cross otherwise.
      const solved = status.passes === status.of;
      return (
        <span className="flex shrink-0 items-center gap-2">
          {time(status.durationMs)}
          <span className="text-right text-sm tabular-nums">
            {status.passes}/{status.of}
          </span>
          {solved ? (
            <IconCheck
              aria-label={t("states.pass")}
              className="size-4 text-success"
            />
          ) : (
            <IconX
              aria-label={t("states.fail")}
              className="size-4 text-destructive"
            />
          )}
        </span>
      );
    }
    case "unscored":
      return (
        <span
          className={cn(
            "flex shrink-0 items-center gap-2 text-xs text-muted-foreground",
            compact && "truncate",
          )}
        >
          {time(status.durationMs)}
          {stateLabel(t, status.outcome)}
        </span>
      );
  }
}
