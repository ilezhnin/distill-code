// One attempt as the steps the runner walks it through: what is behind it,
// where it is now and what is still ahead. The attempt dialog draws this as
// its trail; everything here is read from the stored attempt alone.
import type { Attempt, Evaluation } from "../types";
import {
  modelDisplayName,
  stateLabel,
  stateTone,
  waitingLabel,
} from "./benchmarkLabels";
import { judgePanelEvidenceLabel } from "./benchmarkRunIssues";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Where a step stands: behind the attempt, being worked on, held back until
 * something outside it changes, still ahead, the one the attempt ended in,
 * or one it never reached.
 */
export type TrailState =
  | "done"
  | "running"
  | "waiting"
  | "pending"
  | "failed"
  | "skipped";

export type TrailStepId =
  | "queue"
  | "prepare"
  | "work"
  | "check"
  | "judges"
  | "result";

/** One thing inside a step: a judge's seat, a check's verdict, a cause. */
export interface TrailSubstep {
  id: string;
  title: string;
  /** A short fact on the right: a score, a time of day. */
  detail?: string;
  state: TrailState;
}

export interface TrailStep {
  id: TrailStepId;
  title: string;
  state: TrailState;
  /** What a step that is not simply done says about itself, in a few words. */
  status?: string;
  /** How long a step behind the attempt took, where both ends were recorded. */
  durationMs?: number | null;
  /** When a running or waiting step began, for its clock. */
  since?: number | null;
  /** The most a running step may take, for its bar. */
  limitMs?: number | null;
  /** Parts gathered of those expected: a panel's votes. */
  count?: string;
  substeps: TrailSubstep[];
}

export interface TrailContext {
  /** Whether a judge panel scores this test. */
  judged: boolean;
  /** The run's state: a paused or stopped run holds its open attempts. */
  runState?: string | null;
  /** The most one test of the run may take, in seconds. */
  timeoutSeconds?: number | null;
  now: number;
  /** A time of day, as the dialog writes one. */
  formatTime: (at: number) => string;
}

const ORDER: TrailStepId[] = [
  "queue",
  "prepare",
  "work",
  "check",
  "judges",
  "result",
];
const JUDGE = new Set(["judge", "judge_failure"]);
const HUMAN = new Set(["human", "human_visual"]);
/** Run states in which nothing of an open attempt moves. */
const HELD = new Set(["paused", "needs_attention"]);
/** Outcomes of an attempt that went through every step. */
const WENT_THROUGH = new Set(["pass", "judged", "completed", "pending_review"]);
/** Outcomes the model's own turn ends an attempt with. */
const IN_WORK = new Set([
  "budget_timeout",
  "budget_reached",
  "no_answer",
  "execution_violation",
]);

/**
 * A recorded reason as words to read: a host error's own message without its
 * payload (which carries account ids), a queue wait without its prefix.
 */
export function reasonWords(reason: string): string {
  let words = reason.trim();
  if (words.startsWith("{")) {
    try {
      const error = JSON.parse(words);
      if (typeof error?.message === "string") words = error.message;
    } catch {
      // Not a host error: the words stand as recorded.
    }
  }
  words = words
    .replace(/^Internal error:\s*/i, "")
    .replace(/^Waiting for local resources(?: to \w+)?:\s*/i, "")
    .replace(/^resource_busy:\s*/i, "")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The outcome a try the run measured again had before it was set aside: the
 * runner keeps it in the reason ("this one: infrastructure_failure").
 */
export function supersededOutcome(attempt: {
  outcome: string | null;
  reason: string | null;
}): string | null {
  if (attempt.outcome !== "superseded") return attempt.outcome;
  return /\(this one: ([a-z_]+)\)/.exec(attempt.reason ?? "")?.[1] ?? null;
}

/**
 * The tries of the same test the run set aside and measured again, newest
 * first: they keep their evidence but count nowhere.
 */
export function earlierTries(attempts: Attempt[], shown: Attempt): Attempt[] {
  return attempts
    .filter(
      (other) =>
        other.id !== shown.id &&
        other.versionId === shown.versionId &&
        other.configuration.id === shown.configuration.id &&
        other.outcome === "superseded" &&
        // A try that never started left nothing to look at.
        (other.startedAt != null || other.sessionId != null),
    )
    .sort(
      (a, b) =>
        (b.startedAt ?? b.finishedAt ?? 0) - (a.startedAt ?? a.finishedAt ?? 0),
    );
}

/** The repetitions of the shown attempt's test that count, in order. */
export function countedRepetitions(
  attempts: Attempt[],
  shown: Attempt,
): Attempt[] {
  return attempts
    .filter(
      (other) =>
        other.versionId === shown.versionId &&
        other.configuration.id === shown.configuration.id &&
        (other.outcome !== "superseded" || other.id === shown.id),
    )
    .sort((a, b) => a.repetition - b.repetition);
}

function settled(attempt: Attempt): boolean {
  return attempt.phase === "terminal" || attempt.phase === "interrupted";
}

/** The step an open attempt is in. */
function current(attempt: Attempt): TrailStepId {
  switch (attempt.phase) {
    case "pending":
      return "queue";
    case "preparing":
    case "dispatching":
      return "prepare";
    case "running":
      return "work";
    case "collecting":
      return "check";
    case "awaiting_judges":
      return "judges";
    default:
      return "result";
  }
}

/** The step a settled attempt ended in, or null when it went through. */
function endedIn(attempt: Attempt, outcome: string | null): TrailStepId | null {
  if (outcome != null && WENT_THROUGH.has(outcome)) return null;
  const judged = attempt.evaluations.some((evaluation) =>
    JUDGE.has(evaluation.provenance),
  );
  if (outcome === "fail" || outcome === "evaluation_error")
    return judged ? "judges" : "check";
  if (judged) return "judges";
  const dispatched =
    attempt.phaseTimes?.dispatched != null || attempt.sessionId != null;
  if (outcome != null && IN_WORK.has(outcome)) return "work";
  if (dispatched) return "work";
  return attempt.startedAt != null ? "prepare" : "queue";
}

function between(
  from: number | null | undefined,
  to: number | null | undefined,
) {
  return from != null && to != null && to >= from ? to - from : null;
}

function isJudge(evaluation: Evaluation): boolean {
  return JUDGE.has(evaluation.provenance);
}

/**
 * The panel's seats of the newest batch: a vote with its score, a judge
 * still asked, one that gave no sheet, and the members not asked yet.
 */
function judgeSeats(
  t: Translate,
  evaluations: Evaluation[],
): { substeps: TrailSubstep[]; count?: string } {
  const start = evaluations
    .map((entry) => entry.provenance)
    .lastIndexOf("render");
  const marker = start >= 0 ? evaluations[start] : null;
  const batch = evaluations.slice(start + 1);
  // A seat asked again keeps only its newest answer.
  const seats = new Map<string, Evaluation>();
  for (const evaluation of batch)
    if (isJudge(evaluation))
      seats.set(evaluation.judge?.id ?? evaluation.id, evaluation);
  const substeps: TrailSubstep[] = [...seats].map(([id, evaluation]) => {
    const voted = evaluation.provenance === "judge" && evaluation.score != null;
    const asked = evaluation.details?.inFlight === true;
    return {
      id,
      title: evaluation.judge
        ? modelDisplayName(evaluation.judge, evaluation.judge.modelName)
        : t("trail.judge"),
      detail: voted
        ? (evaluation.score as number).toFixed(2)
        : asked
          ? undefined
          : stateLabel(t, evaluation.verdict),
      state: voted ? "done" : asked ? "running" : "failed",
    };
  });
  const protocol = marker?.details?.protocol;
  const panel =
    protocol && typeof protocol === "object" && "panel" in protocol
      ? (protocol as { panel?: unknown }).panel
      : null;
  if (Array.isArray(panel))
    for (const member of panel) {
      if (
        !member ||
        typeof member !== "object" ||
        typeof member.id !== "string" ||
        typeof member.providerId !== "string" ||
        typeof member.modelId !== "string" ||
        seats.has(member.id)
      )
        continue;
      substeps.push({
        id: member.id,
        title: modelDisplayName(member),
        state: "pending",
      });
    }
  for (const evaluation of batch)
    if (HUMAN.has(evaluation.provenance))
      substeps.push({
        id: evaluation.id,
        title: t("trail.humanReview"),
        detail: evaluation.score?.toFixed(2),
        state: "done",
      });
  const expected = marker?.details?.expectedJudges;
  const votes = substeps.filter(
    (substep) => substep.state === "done" && seats.has(substep.id),
  ).length;
  return {
    substeps,
    count:
      typeof expected === "number" && expected > 0
        ? `${votes}/${expected}`
        : undefined,
  };
}

/**
 * The attempt's trail. A step behind it reads done with its time, the one it
 * is in says what it does and since when, the rest wait their turn; a settled
 * attempt marks the step it ended in and leaves the ones after it out.
 */
export function attemptTrail(
  t: Translate,
  attempt: Attempt,
  context: TrailContext,
): TrailStep[] {
  const times = attempt.phaseTimes ?? {};
  const spans = attempt.activity?.spans ?? [];
  const over = settled(attempt);
  const outcome = supersededOutcome(attempt);
  const judges =
    context.judged ||
    attempt.phase === "awaiting_judges" ||
    attempt.evaluations.some(
      (evaluation) => isJudge(evaluation) || HUMAN.has(evaluation.provenance),
    );
  const ids = ORDER.filter((id) => id !== "judges" || judges);
  const at = over ? null : current(attempt);
  const ended = over ? endedIn(attempt, outcome) : null;
  const held =
    !over && context.runState != null && HELD.has(context.runState)
      ? stateLabel(t, context.runState)
      : null;
  const reason = attempt.reason?.trim() || null;
  // A wait before the answer is the queue's; one after it is the panel's.
  const answered = times.collected ?? Number.POSITIVE_INFINITY;
  const open = spans.find(
    (span) => span.kind === "waiting" && span.finishedAt == null,
  );
  const queued = spans
    .filter(
      (span) =>
        span.kind === "waiting" &&
        span.finishedAt != null &&
        span.startedAt < answered,
    )
    .reduce(
      (sum, span) => sum + ((span.finishedAt as number) - span.startedAt),
      0,
    );
  const checks = attempt.evaluations.filter(
    (evaluation) =>
      !isJudge(evaluation) &&
      !HUMAN.has(evaluation.provenance) &&
      evaluation.provenance !== "render" &&
      evaluation.verdict !== "pending_review",
  );
  const votes = attempt.evaluations.filter(isJudge);
  const judging =
    attempt.phase === "awaiting_judges" &&
    ((times.judgeStarted != null &&
      (times.judgeFinished == null ||
        times.judgeStarted > times.judgeFinished)) ||
      votes.some((evaluation) => evaluation.details?.inFlight === true));

  return ids.map((id): TrailStep => {
    const index = ids.indexOf(id);
    let state: TrailState;
    if (at != null) {
      const now = ids.indexOf(at);
      state = index < now ? "done" : index > now ? "pending" : "running";
    } else if (ended == null) {
      state = "done";
    } else {
      const stop = ids.indexOf(ended);
      state =
        index < stop
          ? "done"
          : index > stop
            ? "skipped"
            : stateTone(outcome) === "negative"
              ? "failed"
              : "skipped";
    }
    const step: TrailStep = {
      id,
      title: t(id === "check" && judges ? "trail.collect" : `trail.${id}`),
      state,
      substeps: [],
    };
    const isCurrent = state === "running";
    // A step the attempt ended in says why, in the runner's or the
    // provider's own words.
    if (over && ended === id && id !== "result" && reason)
      step.substeps.push({
        id: "reason",
        title: reasonWords(reason),
        state: step.state,
      });

    switch (id) {
      case "queue":
        if (isCurrent) {
          step.state = "waiting";
          const until =
            attempt.waitUntil != null && attempt.waitUntil > context.now
              ? attempt.waitUntil
              : null;
          const label = reason
            ? waitingLabel(reason, false, until != null)
            : "modelRun.queued";
          step.status = t(label, {
            time: until == null ? undefined : context.formatTime(until),
          });
          step.since = open?.startedAt ?? null;
          if (reason)
            step.substeps.push({
              id: "reason",
              title: reasonWords(reason),
              state: "waiting",
            });
          // A label that names the time already says when.
          if (until != null && !label.endsWith("Until"))
            step.substeps.push({
              id: "until",
              title: t("trail.nextTry"),
              detail: context.formatTime(until),
              state: "pending",
            });
        } else if (state === "done" && queued > 0) step.durationMs = queued;
        break;
      case "prepare":
        if (isCurrent) {
          step.status = t("states.preparing");
          step.since = attempt.startedAt;
        } else if (state !== "pending")
          step.durationMs = between(
            attempt.startedAt,
            times.sessionOpened ?? times.dispatched,
          );
        break;
      case "work": {
        const began = times.dispatched ?? attempt.startedAt;
        if (isCurrent) {
          step.status = t("states.running");
          step.since = began;
          step.limitMs =
            context.timeoutSeconds != null && context.timeoutSeconds > 0
              ? context.timeoutSeconds * 1000
              : null;
        } else if (state === "done" || ended === "work")
          step.durationMs =
            attempt.durationMs ??
            between(began, times.collected ?? attempt.finishedAt);
        break;
      }
      case "check": {
        const began = times.checkStarted ?? times.collected;
        if (isCurrent) {
          step.status = t("states.collecting");
          step.since = began ?? null;
        } else if (state === "done" || state === "failed")
          step.durationMs = between(began, checks.at(-1)?.createdAt);
        // What each check said; a panel task's placeholders say nothing.
        if (!judges)
          for (const evaluation of checks)
            step.substeps.push({
              id: evaluation.id,
              title: evaluation.reason || stateLabel(t, evaluation.verdict),
              detail: stateLabel(t, evaluation.verdict),
              state:
                stateTone(evaluation.verdict) === "negative"
                  ? "failed"
                  : "done",
            });
        break;
      }
      case "judges": {
        const seats = judgeSeats(t, attempt.evaluations);
        step.count = seats.count;
        step.substeps.push(...seats.substeps);
        if (isCurrent) {
          if (judging) {
            step.status = t("trail.judging");
            step.since = times.judgeStarted ?? null;
          } else {
            step.state = "waiting";
            step.status = t("modelRun.waitingJudges");
            step.since = open?.startedAt ?? null;
            // Why no judge is asked yet, in the runner's words.
            if (reason)
              step.substeps.unshift({
                id: "reason",
                title: judgePanelEvidenceLabel(t, reasonWords(reason)),
                state: "waiting",
              });
          }
        } else if (state === "done" || state === "failed")
          step.durationMs = between(
            times.judgeStarted,
            Math.max(
              ...votes.map((evaluation) => evaluation.createdAt),
              times.judgeFinished ?? 0,
            ),
          );
        break;
      }
      case "result":
        if (over) {
          step.state =
            stateTone(outcome) === "negative"
              ? "failed"
              : // An answer still to be reviewed has no result yet.
                attempt.outcome === "pending_review"
                ? "waiting"
                : ended == null
                  ? "done"
                  : "skipped";
          step.status = stateLabel(t, attempt.outcome ?? attempt.phase);
          // A try the run set aside names what it had come to.
          if (attempt.outcome === "superseded" && outcome != null)
            step.substeps.push({
              id: "outcome",
              title: stateLabel(t, outcome),
              state: step.state,
            });
          // An attempt that went through every step keeps what its result
          // still waits for here: a panel that could not be seated.
          if (ended == null && reason)
            step.substeps.push({
              id: "reason",
              title:
                attempt.outcome === "pending_review"
                  ? judgePanelEvidenceLabel(t, reason)
                  : reasonWords(reason),
              state: step.state,
            });
        }
        break;
    }
    // A paused or stopped run holds whatever its open attempts were doing.
    if (
      held != null &&
      id !== "result" &&
      (step.state === "running" || step.state === "waiting")
    ) {
      step.state = "waiting";
      step.status = held;
      // No clock runs while nothing moves.
      step.since = null;
      step.limitMs = null;
    }
    return step;
  });
}
