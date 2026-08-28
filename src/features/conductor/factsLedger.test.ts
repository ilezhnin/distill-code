import { describe, expect, it } from "vitest";

import {
  buildFactsLedger,
  MIN_FACT_OBSERVATIONS,
  renderFactsForPrompt,
} from "./factsLedger";
import type {
  WaveStepTelemetry,
  WaveTelemetryRecord,
} from "./waveTelemetryStore";

function step(over: Partial<WaveStepTelemetry> = {}): WaveStepTelemetry {
  return {
    stepIndex: 0,
    role: "brigade",
    access: "none",
    outcome: "completed",
    reportDegraded: false,
    modelId: "sol",
    harnessId: "codex-acp",
    ...over,
  };
}

function record(over: Partial<WaveTelemetryRecord> = {}): WaveTelemetryRecord {
  return {
    waveId: "w",
    conductorSessionId: "c1",
    rootRequestId: "r",
    revisionIndex: 0,
    createdAt: 0,
    closedAt: 1,
    durationMs: 1,
    outcome: "accepted",
    digestAttempt: 0,
    stepCount: 1,
    degradedStepCount: 0,
    steps: [step()],
    ...over,
  };
}

function times(n: number, make: (index: number) => WaveTelemetryRecord) {
  return Array.from({ length: n }, (_, index) => make(index));
}

describe("buildFactsLedger", () => {
  it("says nothing until there is enough to say", () => {
    // A model that failed its one and only step would otherwise read as
    // "fails 100% of the time" forever.
    const few = times(MIN_FACT_OBSERVATIONS - 1, (i) =>
      record({ waveId: `w${i}` }),
    );
    expect(buildFactsLedger(few).steps).toEqual([]);
    expect(buildFactsLedger(few).conductors).toEqual([]);
  });

  it("counts completions and reportless steps per role and model", () => {
    const records = times(6, (i) =>
      record({
        waveId: `w${i}`,
        steps: [
          step({ outcome: i < 4 ? "completed" : "failed" }),
          step({ stepIndex: 1, reportDegraded: i === 0 }),
        ],
      }),
    );
    const [fact] = buildFactsLedger(records).steps;
    expect(fact).toMatchObject({
      role: "brigade",
      modelId: "sol",
      runs: 12,
      completed: 10,
      degraded: 1,
    });
  });

  it("keeps two models on the same role apart", () => {
    const records = [
      ...times(5, (i) => record({ waveId: `a${i}` })),
      ...times(5, (i) =>
        record({ waveId: `b${i}`, steps: [step({ modelId: "opus" })] }),
      ),
    ];
    expect(
      buildFactsLedger(records)
        .steps.map((fact) => fact.modelId)
        .sort(),
    ).toEqual(["opus", "sol"]);
  });

  it("ignores a step that never landed on a model", () => {
    // A step that never spawned has no model to be a fact about.
    const records = times(6, (i) =>
      record({ waveId: `w${i}`, steps: [step({ modelId: undefined })] }),
    );
    expect(buildFactsLedger(records).steps).toEqual([]);
  });

  it("counts what happened to the waves each conductor model planned", () => {
    const records = times(6, (i) =>
      record({
        waveId: `w${i}`,
        conductorModelId: "fable",
        outcome: i < 3 ? "accepted" : "revised",
      }),
    );
    expect(buildFactsLedger(records).conductors[0]).toMatchObject({
      modelId: "fable",
      waves: 6,
      accepted: 3,
      revised: 3,
      needsOperator: 0,
    });
  });

  it("puts the best-evidenced fact first", () => {
    const records = [
      ...times(10, (i) => record({ waveId: `a${i}` })),
      ...times(5, (i) =>
        record({ waveId: `b${i}`, steps: [step({ role: "qa" })] }),
      ),
    ];
    expect(buildFactsLedger(records).steps[0].role).toBe("brigade");
  });
});

describe("renderFactsForPrompt", () => {
  it("says nothing when there is nothing measured", () => {
    expect(renderFactsForPrompt({ steps: [], conductors: [] })).toBe("");
  });

  it("states counts with their sample size, never a recommendation", () => {
    // Reputational priors are a refused idea; a measurement with its n is the
    // sanctioned replacement, and the wording has to stay on that side.
    const text = renderFactsForPrompt(
      buildFactsLedger(
        times(6, (i) => record({ waveId: `w${i}`, conductorModelId: "fable" })),
      ),
    );
    expect(text).toContain("6 of 6 completed");
    expect(text).toContain("100% accepted");
    expect(text).not.toMatch(/prefer|better|best|should use/i);
  });
});
