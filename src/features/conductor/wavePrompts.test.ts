import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  MAX_WAVE_STEPS,
  WAVE_FENCE_TAG,
  type WaveStep,
  parseDistillWave,
} from "./distillWave";
import { VERDICT_FENCE_TAG, VERDICT_TOKENS } from "./distillVerdict";
import type { StructuredReport } from "./types";
import { admitWavePlan } from "./waveEngine";
import {
  CONDUCTOR_PROTOCOL_PROMPT,
  type CompletedWaveStepReport,
  WAVE_REPLAN_REQUEST_PROMPT,
  buildConductorProtocolPrompt,
  buildWaveGitDeltaLine,
  buildWaveReplanRequest,
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
  it("is the value the builder produces", () => {
    expect(CONDUCTOR_PROTOCOL_PROMPT).toBe(buildConductorProtocolPrompt());
  });

  it("states the plan-or-answer-only gate", () => {
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain("plan or you answer");
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain("A direct answer");
  });

  it("sanctions read-only lookups and reserves state changes for waves", () => {
    // The Q6 badge is tiered the same way (`conductorSelfExecution.ts`):
    // prompt and badge must draw the identical line, or the conductor is
    // punished for doing what it was told it may do.
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain(
      "Reading is not doing the work",
    );
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain("work belongs to a wave");
  });

  it("teaches the wave fence and the step cap", () => {
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain(`\`\`\`${WAVE_FENCE_TAG}`);
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain(
      `At most ${MAX_WAVE_STEPS} steps`,
    );
  });

  it("warns about the missing-final-brace failure mode", () => {
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain("ends with `}]}`");
  });

  it("teaches both access values and forbids fine-grained lists", () => {
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain('"access": []');
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain('"access": "all"');
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain("no lists of step indexes");
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain("never transcripts");
  });

  it("lists only worker-layer roles as legal step roles", () => {
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain("researcher");
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain("brigade");
    expect(CONDUCTOR_PROTOCOL_PROMPT).not.toContain(", planner");
  });

  it("teaches the verdict fence with all three tokens", () => {
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain(`\`\`\`${VERDICT_FENCE_TAG}`);
    for (const token of Object.values(VERDICT_TOKENS)) {
      expect(CONDUCTOR_PROTOCOL_PROMPT).toContain(`"${token}"`);
    }
  });

  it("carries an example wave that the parser accepts", () => {
    const example = CONDUCTOR_PROTOCOL_PROMPT.slice(
      CONDUCTOR_PROTOCOL_PROMPT.indexOf("## Wave format"),
      CONDUCTOR_PROTOCOL_PROMPT.indexOf("Rules, all enforced"),
    );
    const parsed = parseDistillWave(example);
    expect(parsed.kind).toBe("plan");
    if (parsed.kind !== "plan") return;
    expect(parsed.steps).toHaveLength(3);
  });

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

  it("states the role and the subtask", () => {
    const prompt = buildWaveStepPrompt(noAccessStep);
    expect(prompt).toContain("Researcher");
    expect(prompt).toContain("role: researcher");
    expect(prompt).toContain("Collect sources on WAL replication");
  });

  it("appends the shared distill-report contract", () => {
    expect(buildWaveStepPrompt(noAccessStep)).toContain("```distill-report");
  });

  it("tells a verify-stage step that acceptance rides on its artifacts", () => {
    const prompt = buildWaveStepPrompt({
      role: "acceptor",
      subtask: "Open the file and confirm the count",
      access: "all",
    });
    expect(prompt).toContain("external evidence");
    expect(prompt).toContain("empty artifacts list");
  });

  it("keeps the evidence clause off non-verify steps", () => {
    // E2 only reads the verification step's report; nagging every researcher
    // and writer about acceptance evidence would just dilute their subtask.
    expect(buildWaveStepPrompt(noAccessStep)).not.toContain(
      "external evidence",
    );
    expect(buildWaveStepPrompt(allAccessStep)).not.toContain(
      "external evidence",
    );
  });

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

  it("embeds valid JSON with a one-based step number", () => {
    const prompt = buildWaveStepPrompt(allAccessStep, [
      completedStep({ stepIndex: 1 }),
    ]);
    const body = prompt.slice(
      prompt.indexOf("```json") + "```json".length,
      prompt.indexOf("```", prompt.indexOf("```json") + 7),
    );
    const parsed = JSON.parse(body) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      step: 2,
      role: "researcher",
      subtask: "Collect sources",
      status: "completed",
      needsOperator: false,
    });
  });

  it("orders embedded reports by step index", () => {
    const prompt = buildWaveStepPrompt(allAccessStep, [
      completedStep({
        stepIndex: 2,
        role: "qa",
        report: report({ summary: "Second summary" }),
      }),
      completedStep({
        stepIndex: 0,
        report: report({ summary: "First summary" }),
      }),
    ]);
    expect(prompt.indexOf("First summary")).toBeLessThan(
      prompt.indexOf("Second summary"),
    );
  });

  it("keeps a failed earlier report in the handoff", () => {
    const prompt = buildWaveStepPrompt(allAccessStep, [
      completedStep({
        report: report({
          status: "failed",
          summary: "Could not reach the registry",
          needsOperator: true,
        }),
      }),
    ]);
    expect(prompt).toContain('"status": "failed"');
    expect(prompt).toContain("Could not reach the registry");
  });

  it("says so when an all-access step has no earlier reports", () => {
    const prompt = buildWaveStepPrompt(allAccessStep, []);
    expect(prompt).toContain("No earlier step of this wave produced a report");
    expect(prompt).not.toContain("```json");
  });

  it("states the step position when the caller supplies it", () => {
    expect(buildWaveStepPrompt(noAccessStep, [], { stepIndex: 1 })).toContain(
      "step 2 of a Distill wave",
    );
    expect(
      buildWaveStepPrompt(noAccessStep, [], { stepIndex: 1, totalSteps: 3 }),
    ).toContain("step 2 of 3");
    expect(buildWaveStepPrompt(noAccessStep)).toContain(
      "a step of a Distill wave",
    );
  });

  it("does not leak the per-step model override into the worker prompt", () => {
    const prompt = buildWaveStepPrompt({ ...noAccessStep, model: "gpt-5" });
    expect(prompt).not.toContain("gpt-5");
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

describe("verification and decomposition guidance", () => {
  it("tells the conductor to split by context boundary, not by job title", () => {
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain("How to split the work");
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain(
      "Split along context boundaries, not job titles.",
    );
  });

  it("requires a last-step artifact verification for checkable work", () => {
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain("## Verification");
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain('role "acceptor"');
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain('"access":"all"');
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain(
      "inspect the artifact directly",
    );
  });

  it("names both verification roles it asks for, and they are legal wave roles", () => {
    for (const role of ["acceptor", "adversary"]) {
      expect(CONDUCTOR_PROTOCOL_PROMPT).toContain(role);
      const parsed = parseDistillWave(
        [
          "```" + WAVE_FENCE_TAG,
          JSON.stringify({
            steps: [{ role, subtask: "Check the build", access: "all" }],
          }),
          "```",
        ].join("\n"),
      );
      expect(parsed.kind).toBe("plan");
    }
  });

  it("forbids accepting checkable work that was never checked", () => {
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain(
      `was checkable and was not checked is "${VERDICT_TOKENS.needsOperator}"`,
    );
  });

  it("gives the worker a stopping condition and a legitimate way to fail", () => {
    const prompt = buildWaveStepPrompt(
      { role: "qa", subtask: "Run the suite", access: [] },
      [],
    );
    expect(prompt).toContain("Do this step and stop.");
    expect(prompt).toContain('"needsOperator": true');
    expect(prompt).toContain('Put in "decisions"');
  });
});

describe("subtask string discipline and the replan request", () => {
  it("forbids raw double quotes and pasted JSON inside subtasks", () => {
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain(
      "never use the double-quote character",
    );
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain(
      "Do not describe the report format",
    );
  });

  it("quotes the parser's complaint back to the model on a retry", () => {
    const request = buildWaveReplanRequest(
      "The distill-wave block is not valid JSON: Expected ',' or '}' after property value in JSON at position 6038.",
    );
    expect(request).toContain("What was wrong with the previous block:");
    expect(request).toContain("position 6038");
    expect(request).toContain("raw double-quote character");
  });

  it("falls back to the plain request when there is no detail", () => {
    expect(buildWaveReplanRequest()).toBe(WAVE_REPLAN_REQUEST_PROMPT);
    expect(buildWaveReplanRequest("  ")).toBe(WAVE_REPLAN_REQUEST_PROMPT);
  });
});

describe("buildWaveGitDeltaLine (E3a)", () => {
  it("names its provenance and states both counts with the delta", () => {
    const line = buildWaveGitDeltaLine({ admissionDirty: 3, digestDirty: 7 });
    expect(line).toContain("APP MEASUREMENT");
    expect(line).toContain("not by any worker");
    expect(line).toContain("7 files with uncommitted changes");
    expect(line).toContain("against 3 when the wave was admitted");
    expect(line).toContain("(+4)");
  });

  it("says 'no change' rather than a mute zero", () => {
    expect(
      buildWaveGitDeltaLine({ admissionDirty: 2, digestDirty: 2 }),
    ).toContain("(no change)");
    // A negative delta (workers committed or reverted files) is stated as-is.
    expect(
      buildWaveGitDeltaLine({ admissionDirty: 5, digestDirty: 1 }),
    ).toContain("(-4)");
  });

  it("speaks singular for one file", () => {
    expect(
      buildWaveGitDeltaLine({ admissionDirty: 0, digestDirty: 1 }),
    ).toContain("1 file with uncommitted changes");
  });

  it("admits when the baseline was never captured instead of implying zero", () => {
    const line = buildWaveGitDeltaLine({ digestDirty: 4 });
    expect(line).toContain("was not captured");
    expect(line).not.toMatch(/against \d/);
  });
});

describe("the orchestrate skill's wave examples (5d)", () => {
  it("every distill-wave fence in the skill is a plan the engine admits", () => {
    // The skill is prose, so nothing type-checks it; this is the pairing
    // test that keeps its examples from drifting away from the parser and
    // the E1 lint the way the protocol prompt's own format example once did.
    const skill = readFileSync(
      resolve(__dirname, "../../../distro/skills/orchestrate/SKILL.md"),
      "utf8",
    );
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
});
