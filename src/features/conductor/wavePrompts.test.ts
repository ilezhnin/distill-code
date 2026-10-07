import { describe, expect, it } from "vitest";
import type { WaveStep } from "./distillWave";
import type { StructuredReport } from "./types";
import {
  MAX_PREVIOUS_REPORTS_CHARS,
  type CompletedWaveStepReport,
  buildWaveStepPrompt,
} from "./wavePrompts";

function report(overrides: Partial<StructuredReport> = {}): StructuredReport {
  return {
    runId: "run-1",
    status: "completed",
    summary: "Found three candidate libraries",
    decisions: ["Dropped the unmaintained one"],
    artifacts: [{ label: "notes.md", path: "docs/notes.md" }],
    risks: [],
    needsOperator: false,
    nextSuggestedTask: null,
    ...overrides,
  };
}

function completedStep(
  overrides: Partial<CompletedWaveStepReport> = {},
): CompletedWaveStepReport {
  return {
    stepIndex: 0,
    role: "researcher",
    subtask: "Collect sources",
    report: report(),
    ...overrides,
  };
}

describe("buildWaveStepPrompt", () => {
  const noAccessStep: WaveStep = {
    role: "researcher",
    subtask: "Collect sources on WAL replication",
    access: [],
  };
  const allAccessStep: WaveStep = {
    role: "writer",
    subtask: "Draft the summary from the findings",
    access: "all",
  };

  it("never embeds reports for an access [] step", () => {
    const prompt = buildWaveStepPrompt(noAccessStep, [completedStep()]);
    expect(prompt).not.toContain("Found three candidate libraries");
    expect(prompt).not.toContain("```json");
  });

  it("bounds the whole handoff, keeping the most recent reports", () => {
    // Each report is capped on its own, but five capped reports are still
    // five: every access:"all" step re-embeds all of them, so the sum has to
    // be bounded too. The newest are what the step is continuing from.
    const fat = (stepIndex: number, marker: string): CompletedWaveStepReport =>
      completedStep({
        stepIndex,
        subtask: `Step ${stepIndex}`,
        report: report({ summary: `${marker} ${"x".repeat(9_000)}` }),
      });
    const prompt = buildWaveStepPrompt(allAccessStep, [
      fat(0, "OLDEST"),
      fat(1, "MIDDLE"),
      fat(2, "NEWEST"),
    ]);

    expect(prompt.length).toBeLessThan(MAX_PREVIOUS_REPORTS_CHARS + 4_000);
    expect(prompt).toContain("NEWEST");
    expect(prompt).not.toContain("OLDEST");
    // The step is told what it is missing rather than left to assume it has
    // everything.
    expect(prompt).toContain("omitted here");
  });
});
