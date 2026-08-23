import { describe, expect, it } from "vitest";
import {
  MAX_WAVE_STEPS,
  WAVE_FENCE_TAG,
  type WaveStep,
  parseDistillWave,
} from "./distillWave";
import { VERDICT_FENCE_TAG, VERDICT_TOKENS } from "./distillVerdict";
import type { StructuredReport } from "./types";
import {
  CONDUCTOR_PROTOCOL_PROMPT,
  type CompletedWaveStepReport,
  buildConductorProtocolPrompt,
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

  it("teaches the wave fence and the step cap", () => {
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain(`\`\`\`${WAVE_FENCE_TAG}`);
    expect(CONDUCTOR_PROTOCOL_PROMPT).toContain(
      `At most ${MAX_WAVE_STEPS} steps`,
    );
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
    expect(parsed.steps).toHaveLength(2);
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
