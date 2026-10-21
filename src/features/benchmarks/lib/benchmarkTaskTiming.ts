import type { ActivitySpan, AttemptActivity, Evaluation } from "../types";

type Span = Pick<ActivitySpan, "startedAt" | "finishedAt">;
export interface TaskActivity {
  execution: Span[];
  waiting: Span[];
  /** Historical checks were not timed, so recorded work is a lower bound. */
  partial: boolean;
}
export interface TimedAttempt {
  phase: string;
  startedAt?: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  activity?: AttemptActivity | null;
  evaluations?: Evaluation[];
}

/** Seconds under a minute, else m:ss, else h:mm:ss. */
export function compactElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  if (minutes > 0) return `${minutes}:${pad(seconds)}`;
  return `${seconds} s`;
}

/** Keep only evidenced work before interval recording was introduced. */
export function taskActivity(
  attempts: TimedAttempt[],
  live = true,
): TaskActivity {
  const result: TaskActivity = { execution: [], waiting: [], partial: false };
  for (const attempt of attempts) {
    const history = attempt.activity;
    result.partial ||=
      history == null ||
      history.complete === false ||
      (attempt.startedAt != null && attempt.startedAt < history.recordedFrom);
    const before = history?.recordedFrom ?? Number.POSITIVE_INFINITY;
    const add = (startedAt: number, finishedAt: number | null) => {
      const end = Math.min(finishedAt ?? before, before);
      if (end > startedAt)
        result.execution.push({
          startedAt,
          finishedAt: Number.isFinite(end) ? end : null,
        });
    };
    const start =
      attempt.startedAt ??
      (attempt.finishedAt != null && attempt.durationMs != null
        ? attempt.finishedAt - attempt.durationMs
        : null);
    if (start != null) {
      if (attempt.finishedAt != null) add(start, attempt.finishedAt);
      else if (
        live &&
        ["preparing", "dispatching", "running"].includes(attempt.phase)
      )
        add(start, null);
    }
    for (const evaluation of attempt.evaluations ?? []) {
      const duration = evaluation.details?.durationMs;
      if (typeof duration === "number" && duration >= 0) {
        add(evaluation.createdAt - duration, evaluation.createdAt);
      } else if (live && evaluation.details?.inFlight === true) {
        add(evaluation.createdAt, null);
      }
    }
    for (const span of history?.spans ?? []) result[span.kind].push(span);
  }
  return result;
}

function ranges(spans: Span[], now: number): [number, number][] {
  const sorted = spans
    .map(
      ({ startedAt, finishedAt }) =>
        [startedAt, Math.max(startedAt, Math.min(finishedAt ?? now, now))] as [
          number,
          number,
        ],
    )
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Parallel repetitions count once; queue time overlapping work is not idle. */
export function activityElapsed(activity: TaskActivity, now: number) {
  const execution = ranges(activity.execution, now);
  const waiting = ranges(activity.waiting, now);
  const length = (items: [number, number][]) =>
    items.reduce((sum, [start, end]) => sum + end - start, 0);
  const overlap = waiting.reduce(
    (sum, [start, end]) =>
      sum +
      execution.reduce(
        (total, [from, to]) =>
          total + Math.max(0, Math.min(end, to) - Math.max(start, from)),
        0,
      ),
    0,
  );
  return {
    execution: execution.length ? length(execution) : null,
    waiting: waiting.length ? Math.max(0, length(waiting) - overlap) : null,
  };
}
