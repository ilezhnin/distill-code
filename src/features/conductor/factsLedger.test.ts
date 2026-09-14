import { describe, expect, it } from "vitest";

import { buildFactsLedger } from "./factsLedger";
import {
  parseWaveTelemetry,
  type WaveStepTelemetry,
  type WaveTelemetryRecord,
} from "./waveTelemetryStore";

function stepOn(modelId: string, effort?: string): WaveStepTelemetry {
  return {
    stepIndex: 0,
    role: "brigade",
    access: "none",
    outcome: "completed",
    reportDegraded: false,
    harnessId: "codex-acp",
    modelId,
    ...(effort ? { effort } : {}),
  };
}

function recordWith(
  waveId: string,
  step: WaveStepTelemetry,
  conductorModelId: string,
): WaveTelemetryRecord {
  return {
    waveId,
    conductorSessionId: "conductor-1",
    conductorHarnessId: "codex-acp",
    conductorModelId,
    rootRequestId: waveId,
    revisionIndex: 0,
    createdAt: 0,
    closedAt: 1,
    durationMs: 1,
    outcome: "accepted",
    digestAttempt: 0,
    stepCount: 1,
    degradedStepCount: 0,
    steps: [step],
  };
}

describe("buildFactsLedger", () => {
  it("counts facts recorded under a folded model id in the same bucket as its base model", () => {
    const records = [
      recordWith("w1", stepOn("gpt-5.6-sol[xhigh]"), "gpt-5.6-sol[low]"),
      recordWith("w2", stepOn("gpt-5.6-sol[xhigh]"), "gpt-5.6-sol[low]"),
      recordWith("w3", stepOn("gpt-5.6-sol", "xhigh"), "gpt-5.6-sol"),
      recordWith("w4", stepOn("gpt-5.6-sol", "high"), "gpt-5.6-sol"),
    ];
    const snapshot = JSON.stringify(records);

    const ledger = buildFactsLedger(records, 1);

    expect(ledger.steps).toEqual([
      expect.objectContaining({
        role: "brigade",
        modelId: "gpt-5.6-sol",
        runs: 4,
        completed: 4,
      }),
    ]);
    expect(ledger.conductors).toEqual([
      expect.objectContaining({ modelId: "gpt-5.6-sol", waves: 4 }),
    ]);
    // Read-time only: the records keep the ids they were written with.
    expect(JSON.stringify(records)).toBe(snapshot);
  });

  it("reads telemetry records old and new: a folded model id as written, effort and fast beside a base one", () => {
    const legacy = recordWith(
      "w1",
      stepOn("gpt-5.6-sol[xhigh]"),
      "gpt-5.6-sol[low]",
    );
    const current = {
      ...recordWith(
        "w2",
        { ...stepOn("gpt-5.6-sol", "xhigh"), fast: false },
        "gpt-5.6-sol",
      ),
      conductorEffort: "low",
      conductorFast: true,
    };
    const parsed = parseWaveTelemetry(
      JSON.parse(
        JSON.stringify({
          records: [
            legacy,
            current,
            {
              ...recordWith("w3", stepOn("grok-4-6"), "grok-4-6"),
              conductorEffort: 5,
              steps: [{ ...stepOn("grok-4-6"), effort: "", fast: "no" }],
            },
          ],
          counters: {},
          planlessHighWater: {},
        }),
      ),
    );

    expect(parsed.records[0].steps[0].modelId).toBe("gpt-5.6-sol[xhigh]");
    expect(parsed.records[0].steps[0]).not.toHaveProperty("effort");
    expect(parsed.records[0].conductorModelId).toBe("gpt-5.6-sol[low]");
    expect(parsed.records[1].steps[0]).toMatchObject({
      modelId: "gpt-5.6-sol",
      effort: "xhigh",
      fast: false,
    });
    expect(parsed.records[1]).toMatchObject({
      conductorEffort: "low",
      conductorFast: true,
    });
    expect(parsed.records[2]).not.toHaveProperty("conductorEffort");
    expect(parsed.records[2].steps[0]).not.toHaveProperty("effort");
    expect(parsed.records[2].steps[0]).not.toHaveProperty("fast");
  });

  it("keeps a context-lane id like opus[1m] as its own model", () => {
    const records = [
      recordWith("w1", stepOn("opus[1m]"), "opus[1m]"),
      recordWith("w2", stepOn("opus"), "opus"),
    ];

    const ledger = buildFactsLedger(records, 1);

    expect(ledger.steps.map((fact) => fact.modelId).sort()).toEqual([
      "opus",
      "opus[1m]",
    ]);
  });
});
