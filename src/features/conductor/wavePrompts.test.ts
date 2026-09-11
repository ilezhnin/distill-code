import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { WAVE_FENCE_TAG, type WaveStep, parseDistillWave } from "./distillWave";
import { VERDICT_FENCE_TAG, parseDistillVerdict } from "./distillVerdict";
import type { StructuredReport } from "./types";
import { admitWavePlan } from "./waveEngine";
import {
  CONDUCTOR_PROTOCOL_PROMPT,
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

describe("CONDUCTOR_PROTOCOL_PROMPT", () => {
  it("shows worked examples, and every fence in the prompt is a plan the ENGINE admits", () => {
    // Few-shots are the largest single win our own ablation measured
    // (Nielsen et al., Table 9: −9.43pp without them), so the prompt carries
    // worked examples — including one request that must NOT become a wave.
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain("## Worked examples");
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain("no wave");

    // Every example is held to admitWavePlan, not just the parser: the format
    // example used to end on a prod-stage writer, which the E1 lint refuses —
    // a conductor imitating the canonical example was handed
    // "verification-step-missing" for its trouble.
    const fences =
      CONDUCTOR_PROTOCOL_PROMPT.match(
        new RegExp(`\`\`\`${WAVE_FENCE_TAG}[\\s\\S]*?\`\`\``, "g"),
      ) ?? [];
    expect(fences.length).toBeGreaterThanOrEqual(3);
    for (const fence of fences) {
      const parsed = parseDistillWave(fence);
      expect(parsed.kind).toBe("plan");
      const admission = admitWavePlan(parsed);
      expect(admission.kind).toBe("accepted");
    }
  });
});

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

  it("embeds the JSON reports for an access all step", () => {
    const prompt = buildWaveStepPrompt(allAccessStep, [completedStep()]);
    expect(prompt).toContain("```json");
    expect(prompt).toContain("Found three candidate libraries");
    expect(prompt).toContain("Dropped the unmaintained one");
    expect(prompt).toContain("notes.md");
    expect(prompt).toContain("not their transcripts");
  });

  it("labels a revision's carried reports as coming from the previous wave", () => {
    const prompt = buildWaveStepPrompt(
      { role: "qa", subtask: "Re-check", access: "all" },
      [
        {
          stepIndex: 0,
          role: "scout",
          subtask: "Find every caller",
          fromPreviousWave: true,
          report: {
            runId: "run-prev",
            status: "completed",
            summary: "Three callers, all in src/",
            decisions: [],
            artifacts: [],
            risks: [],
            needsOperator: false,
            nextSuggestedTask: null,
          },
        },
        {
          stepIndex: 0,
          role: "scout",
          subtask: "Re-run the search",
          report: {
            runId: "run-now",
            status: "completed",
            summary: "Still three",
            decisions: [],
            artifacts: [],
            risks: [],
            needsOperator: false,
            nextSuggestedTask: null,
          },
        },
      ],
    );

    // Q4: a revision has to be able to tell what it is revising from what its
    // own siblings just did, or "the revision sees what happened" is a claim
    // with no mechanism behind it.
    expect(prompt).toContain('"wave": "previous"');
    expect(prompt).toContain('"wave": "current"');
    expect(prompt).toContain("that is what is being revised");
    // Previous-wave reports come first, whatever order the caller passed.
    expect(prompt.indexOf("Three callers, all in src/")).toBeLessThan(
      prompt.indexOf("Still three"),
    );
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
