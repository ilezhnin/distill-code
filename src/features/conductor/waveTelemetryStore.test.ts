import { beforeEach, describe, expect, it } from "vitest";

import {
  recordSessionTokens,
  resetUsageLedgerForTests,
} from "@/features/stats/lib/usageLedger";

import { useConductorGraphStore } from "./conductorGraphStore";
import type { SessionNode } from "./types";
import {
  createWaveState,
  withWaveStepPhase,
  type WaveState,
} from "./waveEngine";
import {
  MAX_WAVE_TELEMETRY_RECORDS,
  WAVE_TELEMETRY_STORAGE_KEY,
  bumpWaveTelemetryCounter,
  countPlanlessConductorTurn,
  getWaveTelemetry,
  parseWaveTelemetry,
  recordWaveClose,
  resetWaveTelemetryForTests,
} from "./waveTelemetryStore";

const CONDUCTOR_ID = "conductor-1";

function workerNode(
  stepIndex: number,
  overrides: Partial<SessionNode> = {},
): SessionNode {
  return {
    sessionId: `child-${stepIndex}`,
    projectId: "project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: CONDUCTOR_ID,
    rootConductorId: CONDUCTOR_ID,
    runId: `run-${stepIndex}`,
    harnessId: "goose",
    displayName: `Worker ${stepIndex}`,
    status: "completed",
    waveId: "wave-1",
    stepIndex,
    ...overrides,
  };
}

function wave(overrides: Partial<WaveState> = {}): WaveState {
  const base = withWaveStepPhase(
    withWaveStepPhase(
      createWaveState({
        waveId: "wave-1",
        conductorSessionId: CONDUCTOR_ID,
        planMessageId: "plan-1",
        steps: [
          { role: "scout", subtask: "one", access: [] },
          { role: "qa", subtask: "two", access: "all" },
        ],
        createdAt: 1_000,
      }),
      0,
      { phase: "spawned", sessionId: "child-0", runId: "run-0" },
    ),
    1,
    { phase: "spawned", sessionId: "child-1", runId: "run-1" },
  );
  return { ...base, ...overrides };
}

describe("waveTelemetryStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetWaveTelemetryForTests();
    resetUsageLedgerForTests();
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
  });

  it("records a closed wave: outcome, durations, tokens, degradations, git counts", () => {
    const graph = useConductorGraphStore.getState();
    graph.registerNode(
      workerNode(0, {
        sessionId: "child-0",
        createdAt: 2_000,
        finishedAt: 7_000,
      }),
    );
    graph.registerNode(
      workerNode(1, { sessionId: "child-1", createdAt: 3_000 }),
    );
    recordSessionTokens("child-0", { totalTokens: 1_500, mode: "replace" });
    recordSessionTokens("child-1", { totalTokens: 500, mode: "replace" });

    const closing = wave({
      gitDirtyAtAdmission: 2,
      gitDirtyAtDigest: 5,
      digestAttempt: 1,
    });
    closing.steps[0] = { ...closing.steps[0], reportDegraded: true };

    recordWaveClose(closing, "accepted", undefined, 10_000);

    const { records } = getWaveTelemetry();
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record).toMatchObject({
      waveId: "wave-1",
      conductorSessionId: CONDUCTOR_ID,
      outcome: "accepted",
      createdAt: 1_000,
      closedAt: 10_000,
      durationMs: 9_000,
      digestAttempt: 1,
      stepCount: 2,
      degradedStepCount: 1,
      gitDirtyAtAdmission: 2,
      gitDirtyAtDigest: 5,
      totalTokens: 2_000,
    });
    expect(record.steps[0]).toMatchObject({
      stepIndex: 0,
      role: "scout",
      access: "none",
      outcome: "completed",
      reportDegraded: true,
      startedAt: 2_000,
      finishedAt: 7_000,
      durationMs: 5_000,
      totalTokens: 1_500,
    });
    // Step 1 never got a finishedAt, so it has no duration — absent, not 0.
    expect(record.steps[1].durationMs).toBeUndefined();
    expect(record.steps[1].totalTokens).toBe(500);
  });

  it("records `never-ran` for a step no child ever registered, `failed` for a failed spawn", () => {
    const closing = wave();
    closing.steps[1] = {
      stepIndex: 1,
      role: "qa",
      subtask: "two",
      access: "all",
      phase: "failed",
    };
    recordWaveClose(closing, "needs-operator", "operator-stopped");

    const record = getWaveTelemetry().records[0];
    expect(record.closureReason).toBe("operator-stopped");
    expect(record.steps[0].outcome).toBe("never-ran");
    expect(record.steps[1].outcome).toBe("failed");
  });

  it("upserts by wave id — a re-armed wave's final close is the record", () => {
    recordWaveClose(wave(), "needs-operator", "verdict-invalid", 5_000);
    recordWaveClose(wave(), "accepted", undefined, 9_000);

    const { records } = getWaveTelemetry();
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("accepted");
    expect(records[0].closedAt).toBe(9_000);
  });

  it("caps the history at the oldest end", () => {
    for (let index = 0; index < MAX_WAVE_TELEMETRY_RECORDS + 10; index += 1) {
      recordWaveClose(
        wave({ waveId: `wave-${index}` }),
        "accepted",
        undefined,
        index,
      );
    }
    const { records } = getWaveTelemetry();
    expect(records).toHaveLength(MAX_WAVE_TELEMETRY_RECORDS);
    expect(records[0].waveId).toBe("wave-10");
  });

  it("keeps the denominators, deduplicated across restart re-scans", () => {
    bumpWaveTelemetryCounter("admittedWaves");
    bumpWaveTelemetryCounter("rejectedPlans");
    countPlanlessConductorTurn(CONDUCTOR_ID, 100);
    countPlanlessConductorTurn(CONDUCTOR_ID, 200);
    // The restart re-scan: same turns come around again, at or below the mark.
    countPlanlessConductorTurn(CONDUCTOR_ID, 100);
    countPlanlessConductorTurn(CONDUCTOR_ID, 200);
    // Another conductor has its own mark.
    countPlanlessConductorTurn("conductor-2", 50);

    const { counters } = getWaveTelemetry();
    expect(counters).toEqual({
      planlessTurns: 3,
      admittedWaves: 1,
      rejectedPlans: 1,
      concurrentRefusals: 0,
    });
  });

  it("persists through its own storage key and salvages what it can on load", () => {
    bumpWaveTelemetryCounter("admittedWaves");
    recordWaveClose(wave(), "revised", undefined, 4_000);

    const stored = window.localStorage.getItem(WAVE_TELEMETRY_STORAGE_KEY);
    expect(stored).toBeTruthy();
    const reloaded = parseWaveTelemetry(JSON.parse(stored ?? "null"));
    expect(reloaded.counters.admittedWaves).toBe(1);
    expect(reloaded.records).toHaveLength(1);
    expect(reloaded.records[0].outcome).toBe("revised");

    // Garbage degrades to empty rather than throwing.
    expect(parseWaveTelemetry(null)).toEqual(
      expect.objectContaining({ records: [] }),
    );
    expect(
      parseWaveTelemetry({
        records: [{ waveId: "w" }, 42, null],
        counters: { admittedWaves: -3, planlessTurns: "many" },
        planlessHighWater: { ok: 5, bad: "x" },
      }).counters,
    ).toEqual({
      planlessTurns: 0,
      admittedWaves: 0,
      rejectedPlans: 0,
      concurrentRefusals: 0,
    });
  });
});
