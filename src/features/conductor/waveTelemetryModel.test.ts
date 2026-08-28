import { describe, expect, it } from "vitest";

import {
  buildWaveTelemetrySummary,
  localDayKey,
  recordsInWindow,
} from "./waveTelemetryModel";
import {
  MAX_WAVE_TELEMETRY_RECORDS,
  emptyWaveTelemetryState,
  type WaveStepTelemetry,
  type WaveTelemetryRecord,
  type WaveTelemetryState,
} from "./waveTelemetryStore";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);

function step(over: Partial<WaveStepTelemetry> = {}): WaveStepTelemetry {
  return {
    stepIndex: 0,
    role: "brigade",
    access: "none",
    outcome: "completed",
    reportDegraded: false,
    ...over,
  };
}

function record(over: Partial<WaveTelemetryRecord> = {}): WaveTelemetryRecord {
  const closedAt = over.closedAt ?? NOW - DAY;
  return {
    waveId: "w1",
    conductorSessionId: "c1",
    rootRequestId: "root-1",
    revisionIndex: 0,
    createdAt: closedAt - 60_000,
    closedAt,
    durationMs: 60_000,
    outcome: "accepted",
    digestAttempt: 0,
    stepCount: 2,
    degradedStepCount: 0,
    steps: [step(), step({ stepIndex: 1, access: "all" })],
    ...over,
  };
}

function state(over: Partial<WaveTelemetryState> = {}): WaveTelemetryState {
  return { ...emptyWaveTelemetryState(), ...over };
}

function summarize(
  s: WaveTelemetryState,
  window: Parameters<typeof buildWaveTelemetrySummary>[1] = {},
) {
  return buildWaveTelemetrySummary(s, { now: NOW, ...window });
}

describe("recordsInWindow", () => {
  it("keeps only what closed inside the window, oldest first", () => {
    const inside = record({ waveId: "in", closedAt: NOW - 2 * DAY });
    const outside = record({ waveId: "out", closedAt: NOW - 40 * DAY });
    const newest = record({ waveId: "new", closedAt: NOW - 1000 });
    const kept = recordsInWindow([newest, outside, inside], 7, NOW);
    expect(kept.map((r) => r.waveId)).toEqual(["in", "new"]);
  });

  it("keeps everything when the window is null", () => {
    const old = record({ waveId: "old", closedAt: NOW - 400 * DAY });
    expect(recordsInWindow([old], null, NOW)).toHaveLength(1);
  });
});

describe("buildWaveTelemetrySummary", () => {
  it("reports nothing rather than zero when no wave has closed", () => {
    // "No wave has closed yet" and "no wave was ever accepted" are opposite
    // facts. A rate of 0 for the first would read as the second.
    const summary = summarize(state());
    expect(summary.waveCount).toBe(0);
    expect(summary.acceptRate).toBeNull();
    expect(summary.meanStepsPerWave).toBeNull();
    expect(summary.medianStepDurationMs).toBeNull();
    expect(summary.totalCostUsd).toBeNull();
  });

  describe("the lifetime counters", () => {
    const counted = state({
      counters: {
        planlessTurns: 70,
        admittedWaves: 30,
        rejectedPlans: 10,
        concurrentRefusals: 3,
      },
    });

    it("divides waves by every settled turn for the orchestration rate", () => {
      // The complexity gate's own report card: 30 of 100 turns became a wave.
      expect(summarize(counted).lifetime.orchestrationRate).toBeCloseTo(0.3);
    });

    it("divides admitted plans by every plan seen for format reliability", () => {
      // The protocol's ~80% threshold is measured against this exact ratio.
      expect(summarize(counted).lifetime.formatReliability).toBeCloseTo(0.75);
    });

    it("does not move when the period changes", () => {
      // Counters carry no timestamps. Windowing them would be invented data,
      // and the pane says so instead of pretending otherwise.
      const week = summarize(counted, { window: 7 }).lifetime;
      const all = summarize(counted, { window: null }).lifetime;
      expect(week).toEqual(all);
    });

    it("has no opinion before anything has been counted", () => {
      expect(summarize(state()).lifetime.orchestrationRate).toBeNull();
      expect(summarize(state()).lifetime.formatReliability).toBeNull();
    });
  });

  it("counts outcomes and the accept rate over the window", () => {
    const summary = summarize(
      state({
        records: [
          record({ waveId: "a", outcome: "accepted" }),
          record({ waveId: "b", outcome: "accepted" }),
          record({ waveId: "c", outcome: "needs-operator" }),
          record({ waveId: "d", outcome: "revised" }),
        ],
      }),
    );
    expect(summary.outcomes).toEqual({
      accepted: 2,
      revised: 1,
      "needs-operator": 1,
      pruned: 0,
    });
    expect(summary.acceptRate).toBeCloseTo(0.5);
  });

  it("counts revisions per root request, not per wave", () => {
    // A root request that took two revisions is three waves and one request.
    // Counting waves would report the revision rate as 2/3 instead of 1/1.
    const summary = summarize(
      state({
        records: [
          record({ waveId: "a", rootRequestId: "r1", revisionIndex: 0 }),
          record({ waveId: "b", rootRequestId: "r1", revisionIndex: 1 }),
          record({ waveId: "c", rootRequestId: "r1", revisionIndex: 2 }),
          record({ waveId: "d", rootRequestId: "r2", revisionIndex: 0 }),
        ],
      }),
    );
    expect(summary.waveCount).toBe(4);
    expect(summary.rootRequestCount).toBe(2);
    expect(summary.revisionRate).toBeCloseTo(0.5);
    expect(summary.meanRevisionsPerRoot).toBeCloseTo(1);
  });

  it("bins waves by step count across the legal range", () => {
    const summary = summarize(
      state({
        records: [
          record({ waveId: "a", stepCount: 1 }),
          record({ waveId: "b", stepCount: 1 }),
          record({ waveId: "c", stepCount: 3 }),
          record({ waveId: "d", stepCount: 5 }),
        ],
      }),
    );
    expect(summary.stepCountHistogram).toEqual([2, 0, 1, 0, 1]);
    expect(summary.meanStepsPerWave).toBeCloseTo(2.5);
  });

  it("takes durations from the steps, nearest-rank", () => {
    // Nearest-rank, so every number the pane shows is a duration some step
    // actually took — which matters when the operator goes looking for it.
    const summary = summarize(
      state({
        records: [
          record({
            waveId: "a",
            steps: [
              step({ durationMs: 1000 }),
              step({ stepIndex: 1, durationMs: 5000 }),
              step({ stepIndex: 2, durationMs: 9000 }),
              step({ stepIndex: 3 }),
            ],
          }),
        ],
      }),
    );
    expect(summary.medianStepDurationMs).toBe(5000);
    expect(summary.p90StepDurationMs).toBe(9000);
    expect(summary.stepCount).toBe(4);
  });

  it("counts degraded steps against every step, not every wave", () => {
    const summary = summarize(
      state({
        records: [
          record({
            waveId: "a",
            steps: [step({ reportDegraded: true }), step({ stepIndex: 1 })],
          }),
        ],
      }),
    );
    expect(summary.degradedStepRate).toBeCloseTo(0.5);
  });

  describe("money", () => {
    it("sums only the waves that carried a price", () => {
      // A wave on an unpriced provider is not a free wave, and adding it as
      // zero would understate the cost multiplier this pane exists to measure.
      const summary = summarize(
        state({
          records: [
            record({ waveId: "a", totalTokens: 1000, costUsd: 0.5 }),
            record({ waveId: "b", totalTokens: 3000 }),
          ],
        }),
      );
      expect(summary.totalTokens).toBe(4000);
      expect(summary.totalCostUsd).toBeCloseTo(0.5);
      expect(summary.meanCostPerWaveUsd).toBeCloseTo(0.5);
    });

    it("says nothing at all when no wave was priced", () => {
      const summary = summarize(
        state({ records: [record({ waveId: "a", totalTokens: 10 })] }),
      );
      expect(summary.totalCostUsd).toBeNull();
      expect(summary.meanCostPerWaveUsd).toBeNull();
    });

    it("averages tokens over the waves that reported any", () => {
      const summary = summarize(
        state({
          records: [
            record({ waveId: "a", totalTokens: 1000 }),
            record({ waveId: "b" }),
          ],
        }),
      );
      expect(summary.meanTokensPerWave).toBe(1000);
    });
  });

  it("groups the daily rows by the viewer's own day", () => {
    const morning = new Date(NOW);
    morning.setHours(9, 0, 0, 0);
    const evening = new Date(NOW);
    evening.setHours(21, 0, 0, 0);
    const summary = summarize(
      state({
        records: [
          record({
            waveId: "a",
            closedAt: morning.getTime(),
            totalTokens: 100,
            costUsd: 0.1,
          }),
          record({
            waveId: "b",
            closedAt: evening.getTime(),
            totalTokens: 200,
          }),
        ],
      }),
      { window: 30 },
    );
    expect(summary.daily).toHaveLength(1);
    expect(summary.daily[0]).toMatchObject({
      day: localDayKey(morning.getTime()),
      waves: 2,
      tokens: 300,
      costUsd: 0.1,
    });
  });

  it("says when the record cap, not the period, is the limit", () => {
    const full = state({
      records: Array.from({ length: MAX_WAVE_TELEMETRY_RECORDS }, (_, i) =>
        record({ waveId: `w${i}`, closedAt: NOW - i * 1000 }),
      ),
    });
    expect(summarize(full, { window: null }).capped).toBe(true);
    expect(summarize(state({ records: [record()] })).capped).toBe(false);
  });
});
