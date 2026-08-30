import { describe, expect, it } from "vitest";

import type { StructuredReport } from "./types";
import { verifyWaveStepReport } from "./waveReportVerification";

function report(overrides: Partial<StructuredReport> = {}): StructuredReport {
  return {
    runId: "run-1",
    status: "completed",
    summary: "Did the thing",
    decisions: [],
    artifacts: [],
    risks: [],
    needsOperator: false,
    nextSuggestedTask: null,
    ...overrides,
  };
}

describe("verifyWaveStepReport", () => {
  it("passes non-completed reports untouched — they are their own signal", () => {
    for (const status of ["failed", "cancelled", "blocked"] as const) {
      expect(
        verifyWaveStepReport(report({ status }), { role: "brigade" }),
      ).toEqual({ ok: true });
    }
  });

  it("refuses a wordless success on any stage", () => {
    const check = verifyWaveStepReport(report({ summary: "   " }), {
      role: "scout",
    });
    expect(check.ok).toBe(false);
  });

  it("refuses a completed prod report with no artifacts and no decisions", () => {
    const check = verifyWaveStepReport(report(), { role: "brigade" });
    expect(check.ok).toBe(false);
    expect(!check.ok && check.detail).toContain("prod-stage");
  });

  it("passes a prod report that carries evidence", () => {
    expect(
      verifyWaveStepReport(
        report({ artifacts: [{ label: "patch", path: "src/a.ts" }] }),
        { role: "brigade" },
      ),
    ).toEqual({ ok: true });
    expect(
      verifyWaveStepReport(report({ decisions: ["kept the old API"] }), {
        role: "unity-worker",
      }),
    ).toEqual({ ok: true });
  });

  it("holds verify-stage reports to the accept gate's own bar: artifacts", () => {
    // Decisions alone do not pass a verifier — E2 requires artifacts on the
    // verification step, and the gate holds every verify step to the same.
    const check = verifyWaveStepReport(report({ decisions: ["looks fine"] }), {
      role: "qa",
    });
    expect(check.ok).toBe(false);
    expect(
      verifyWaveStepReport(
        report({ artifacts: [{ label: "test log", path: "logs/run.txt" }] }),
        { role: "qa" },
      ),
    ).toEqual({ ok: true });
  });

  it("asks only for a summary from pre/release/post stages and unknown roles", () => {
    for (const role of ["scout", "pr-submitter", "marketer", "who-knows"]) {
      expect(verifyWaveStepReport(report(), { role })).toEqual({ ok: true });
    }
  });
});
