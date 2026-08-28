/**
 * Reading wave telemetry back: the numbers, without a chart in sight.
 *
 * The store has been collecting since the closed loop shipped and nothing has
 * ever read it. That is not a missing screen — it is why six questions about
 * this product are still opinions. Where the complexity gate belongs (D3),
 * what orchestration actually multiplies a request's cost by, how often the
 * fenced format breaks at all: each has an answer sitting in localStorage.
 *
 * Everything here is pure. The pane is a rendering of this, so the arithmetic
 * can be tested without a DOM, and so a number the operator disputes can be
 * checked by hand against the same record list.
 *
 * ## Two clocks, and why the summary says so
 *
 * The store keeps two different kinds of fact, and mixing them would produce
 * confident nonsense:
 *
 * - **Records** carry `closedAt`, so they can be windowed to a period. They
 *   are capped at {@link MAX_WAVE_TELEMETRY_RECORDS}, so "all time" here
 *   really means "the last 200 waves".
 * - **Counters** (planless turns, admitted waves, rejected plans, concurrent
 *   refusals) are cumulative integers with no timestamps. They cannot be
 *   windowed at all.
 *
 * So every rate built from counters is lifetime, every rate built from
 * records is windowed, and the summary labels which is which rather than
 * quietly presenting them side by side as if they covered the same days.
 */

import {
  MAX_WAVE_TELEMETRY_RECORDS,
  type WaveTelemetryOutcome,
  type WaveTelemetryRecord,
  type WaveTelemetryState,
} from "./waveTelemetryStore";

/** The periods the pane offers. `null` is "everything the cap kept". */
export type WaveTelemetryWindow = 1 | 7 | 30 | null;

export interface WaveTelemetryDailyPoint {
  /** `YYYY-MM-DD` in local time — the operator's day, not UTC's. */
  day: string;
  waves: number;
  tokens: number;
  /** Absent when no wave that day had a priced provider. */
  costUsd?: number;
}

/**
 * Lifetime rates, from the counters. Named apart from the windowed block on
 * purpose: these do not move when the operator picks a shorter period.
 */
export interface WaveTelemetryLifetime {
  planlessTurns: number;
  admittedWaves: number;
  rejectedPlans: number;
  concurrentRefusals: number;
  /**
   * Share of settled conductor turns that became a wave. The D3 gate's own
   * report card: a number near 1 means the conductor orchestrates everything,
   * which is the failure the gate exists to prevent.
   */
  orchestrationRate: number | null;
  /**
   * Share of plans that parsed and were admitted. The protocol's threshold —
   * below about 0.8 the format itself is the bottleneck and no conclusion
   * about orchestration's value is worth drawing.
   */
  formatReliability: number | null;
}

export interface WaveTelemetrySummary {
  window: WaveTelemetryWindow;
  /** True when the cap, not the window, is what limited the record list. */
  capped: boolean;
  lifetime: WaveTelemetryLifetime;

  waveCount: number;
  rootRequestCount: number;
  firstClosedAt: number | null;
  lastClosedAt: number | null;

  outcomes: Record<WaveTelemetryOutcome, number>;
  /** Share of closed waves the conductor accepted. */
  acceptRate: number | null;
  /** Share of root requests that spent at least one revision. */
  revisionRate: number | null;
  meanRevisionsPerRoot: number | null;

  meanStepsPerWave: number | null;
  /** Waves by step count; index 0 is one step, index 4 is five. */
  stepCountHistogram: number[];
  stepCount: number;
  /** Share of steps that went terminal on the "result unknown" stub. */
  degradedStepRate: number | null;

  medianStepDurationMs: number | null;
  p90StepDurationMs: number | null;
  medianWaveDurationMs: number | null;

  totalTokens: number;
  meanTokensPerWave: number | null;
  /** Absent, not zero, when nothing in the window had a priced provider. */
  totalCostUsd: number | null;
  meanCostPerWaveUsd: number | null;
  daily: WaveTelemetryDailyPoint[];
}

const OUTCOME_KEYS: readonly WaveTelemetryOutcome[] = [
  "accepted",
  "revised",
  "needs-operator",
  "pruned",
];

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Nearest-rank quantile over a copy of the input.
 *
 * Nearest-rank rather than interpolated: every value it can return is a
 * duration some step actually took, which matters when the operator goes
 * looking for the step that took it.
 */
function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** `YYYY-MM-DD` in the viewer's own timezone. */
export function localDayKey(at: number): string {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Records closed inside the window, oldest first. */
export function recordsInWindow(
  records: readonly WaveTelemetryRecord[],
  window: WaveTelemetryWindow,
  now: number,
): WaveTelemetryRecord[] {
  const kept =
    window === null
      ? [...records]
      : records.filter(
          (record) => record.closedAt >= now - window * 24 * 60 * 60 * 1000,
        );
  return kept.sort((left, right) => left.closedAt - right.closedAt);
}

function dailyPoints(
  records: readonly WaveTelemetryRecord[],
): WaveTelemetryDailyPoint[] {
  const byDay = new Map<string, WaveTelemetryDailyPoint>();
  for (const record of records) {
    const day = localDayKey(record.closedAt);
    const point = byDay.get(day) ?? { day, waves: 0, tokens: 0 };
    point.waves += 1;
    point.tokens += record.totalTokens ?? 0;
    if (record.costUsd !== undefined) {
      // Only waves that actually carried a price contribute. A wave on an
      // unpriced provider must not read as a free one.
      point.costUsd = (point.costUsd ?? 0) + record.costUsd;
    }
    byDay.set(day, point);
  }
  return [...byDay.values()].sort((left, right) =>
    left.day.localeCompare(right.day),
  );
}

/**
 * Everything the pane shows, from one state and one clock reading.
 *
 * Rates are `null`, never `0`, when their denominator is empty: "no waves have
 * closed yet" and "no wave was ever accepted" are opposite facts and the pane
 * has to be able to say which one it is looking at.
 */
export function buildWaveTelemetrySummary(
  state: WaveTelemetryState,
  options: { window?: WaveTelemetryWindow; now?: number } = {},
): WaveTelemetrySummary {
  const window = options.window ?? 7;
  const now = options.now ?? Date.now();
  const records = recordsInWindow(state.records, window, now);

  const outcomes = Object.fromEntries(
    OUTCOME_KEYS.map((key) => [key, 0]),
  ) as Record<WaveTelemetryOutcome, number>;
  for (const record of records) outcomes[record.outcome] += 1;

  const roots = new Map<string, number>();
  for (const record of records) {
    roots.set(
      record.rootRequestId,
      Math.max(roots.get(record.rootRequestId) ?? 0, record.revisionIndex),
    );
  }
  const revisionsPerRoot = [...roots.values()];

  const stepCountHistogram = [0, 0, 0, 0, 0];
  for (const record of records) {
    const index =
      Math.min(stepCountHistogram.length, Math.max(1, record.stepCount)) - 1;
    stepCountHistogram[index] += 1;
  }

  const steps = records.flatMap((record) => record.steps);
  const stepDurations = steps.flatMap((step) =>
    step.durationMs !== undefined ? [step.durationMs] : [],
  );
  const priced = records.flatMap((record) =>
    record.costUsd !== undefined ? [record.costUsd] : [],
  );
  const totalTokens = records.reduce(
    (sum, record) => sum + (record.totalTokens ?? 0),
    0,
  );
  const tokenBearing = records.filter(
    (record) => record.totalTokens !== undefined,
  );

  const { counters } = state;
  const settledTurns = counters.planlessTurns + counters.admittedWaves;
  const plansSeen = counters.admittedWaves + counters.rejectedPlans;

  return {
    window,
    capped: state.records.length >= MAX_WAVE_TELEMETRY_RECORDS,
    lifetime: {
      planlessTurns: counters.planlessTurns,
      admittedWaves: counters.admittedWaves,
      rejectedPlans: counters.rejectedPlans,
      concurrentRefusals: counters.concurrentRefusals,
      orchestrationRate: ratio(counters.admittedWaves, settledTurns),
      formatReliability: ratio(counters.admittedWaves, plansSeen),
    },

    waveCount: records.length,
    rootRequestCount: roots.size,
    firstClosedAt: records[0]?.closedAt ?? null,
    lastClosedAt: records.at(-1)?.closedAt ?? null,

    outcomes,
    acceptRate: ratio(outcomes.accepted, records.length),
    revisionRate: ratio(
      revisionsPerRoot.filter((count) => count > 0).length,
      revisionsPerRoot.length,
    ),
    meanRevisionsPerRoot: mean(revisionsPerRoot),

    meanStepsPerWave: mean(records.map((record) => record.stepCount)),
    stepCountHistogram,
    stepCount: steps.length,
    degradedStepRate: ratio(
      steps.filter((step) => step.reportDegraded).length,
      steps.length,
    ),

    medianStepDurationMs: quantile(stepDurations, 0.5),
    p90StepDurationMs: quantile(stepDurations, 0.9),
    medianWaveDurationMs: quantile(
      records.map((record) => record.durationMs),
      0.5,
    ),

    totalTokens,
    meanTokensPerWave: mean(
      tokenBearing.map((record) => record.totalTokens ?? 0),
    ),
    totalCostUsd:
      priced.length > 0 ? priced.reduce((sum, value) => sum + value, 0) : null,
    meanCostPerWaveUsd: mean(priced),
    daily: dailyPoints(records),
  };
}
