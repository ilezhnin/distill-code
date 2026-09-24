import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { WAVE_FENCE_TAG, type WaveStep, parseDistillWave } from "./distillWave";
import { VERDICT_FENCE_TAG, parseDistillVerdict } from "./distillVerdict";
import type { StructuredReport } from "./types";
import { admitWavePlan } from "./waveEngine";
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

function readSkill(): string {
  return readFileSync(
    resolve(__dirname, "../../../distro/skills/orchestrate/SKILL.md"),
    "utf8",
  );
}

describe("the orchestrate skill's wave examples (5d)", () => {
  it("every distill-wave fence in the skill is a plan the engine admits", () => {
    // The skill is prose, so nothing type-checks it; this is the pairing
    // test that keeps its examples from drifting away from the parser and
    // the E1 lint the way the protocol prompt's own format example once did.
    const skill = readSkill();
    const fences =
      skill.match(new RegExp(`\`\`\`${WAVE_FENCE_TAG}[\\s\\S]*?\`\`\``, "g")) ??
      [];
    expect(fences.length).toBeGreaterThanOrEqual(2);
    for (const fence of fences) {
      const parsed = parseDistillWave(fence);
      expect(parsed.kind).toBe("plan");
      expect(admitWavePlan(parsed).kind).toBe("accepted");
    }
  });

  it("every distill-verdict fence in the skill parses", () => {
    const skill = readSkill();
    const fences =
      skill.match(
        new RegExp(`\`\`\`${VERDICT_FENCE_TAG}[\\s\\S]*?\`\`\``, "g"),
      ) ?? [];
    expect(fences.length).toBeGreaterThanOrEqual(1);
    for (const fence of fences) {
      expect(parseDistillVerdict(fence).kind).toBe("verdict");
    }
  });
});
