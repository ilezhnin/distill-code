import { describe, expect, it } from "vitest";
import {
  MAX_WAVE_STEPS,
  WAVE_FENCE_TAG,
  type WaveInvalidReason,
  allowedWaveRoleIds,
  parseDistillWave,
  parseWavePlanBody,
  parseWaveStep,
  scanFencedBlock,
} from "./distillWave";

function fence(body: string): string {
  return [`\`\`\`${WAVE_FENCE_TAG}`, body, "```"].join("\n");
}

function expectInvalid(text: string, reason: WaveInvalidReason) {
  const parsed = parseDistillWave(text);
  expect(parsed.kind).toBe("invalid");
  if (parsed.kind !== "invalid") return;
  expect(parsed.reason).toBe(reason);
  expect(parsed.detail.length).toBeGreaterThan(0);
  return parsed;
}

describe("parseDistillWave — none", () => {
  it("treats a message without a fence as an ordinary answer", () => {
    expect(parseDistillWave("Paris is the capital of France.")).toEqual({
      kind: "none",
    });
  });

  it("ignores an unrelated fenced block", () => {
    const text = 'Here you go:\n\n```json\n{"steps":[]}\n```';
    expect(parseDistillWave(text)).toEqual({ kind: "none" });
  });

  it("ignores the tag mentioned inline in prose", () => {
    expect(
      parseDistillWave("Emit a ```distill-wave block when you plan."),
    ).toEqual({ kind: "none" });
  });

  it("ignores a distill-report fence from a worker", () => {
    const text = '```distill-report\n{"status":"completed"}\n```';
    expect(parseDistillWave(text)).toEqual({ kind: "none" });
  });
});

describe("parseDistillWave — plan", () => {
  it("parses a single-step wave", () => {
    const parsed = parseDistillWave(
      fence(
        '{"steps":[{"role":"researcher","subtask":"Survey the options","access":[]}]}',
      ),
    );
    expect(parsed.kind).toBe("plan");
    if (parsed.kind !== "plan") return;
    expect(parsed.steps).toEqual([
      { role: "researcher", subtask: "Survey the options", access: [] },
    ]);
    expect(parsed.planText).toContain('"steps"');
    expect(parsed.prose).toBe("");
  });

  it("parses a multi-step wave with an all-access step and keeps the prose", () => {
    const parsed = parseDistillWave(
      `Splitting this in two.\n\n${fence(
        '{"steps":[{"role":"researcher","subtask":"Collect sources","access":[]},{"role":"writer","subtask":"Draft from the findings","access":"all"}]}',
      )}\n\nI will report back.`,
    );
    expect(parsed.kind).toBe("plan");
    if (parsed.kind !== "plan") return;
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[1].access).toBe("all");
    expect(parsed.prose).toBe("Splitting this in two.\n\nI will report back.");
  });

  it("normalizes the role id and trims the subtask", () => {
    const parsed = parseDistillWave(
      fence(
        '{"steps":[{"role":" QA ","subtask":"  Run the suite  ","access":[]}]}',
      ),
    );
    expect(parsed.kind).toBe("plan");
    if (parsed.kind !== "plan") return;
    expect(parsed.steps[0]).toEqual({
      role: "qa",
      subtask: "Run the suite",
      access: [],
    });
  });

  it("keeps an explicit per-step model", () => {
    const parsed = parseDistillWave(
      fence(
        '{"steps":[{"role":"qa","subtask":"Run the suite","access":[],"model":"gpt-5"}]}',
      ),
    );
    expect(parsed.kind).toBe("plan");
    if (parsed.kind !== "plan") return;
    expect(parsed.steps[0].model).toBe("gpt-5");
  });

  it("omits model when the field is absent", () => {
    const parsed = parseDistillWave(
      fence('{"steps":[{"role":"qa","subtask":"Run the suite","access":[]}]}'),
    );
    expect(parsed.kind).toBe("plan");
    if (parsed.kind !== "plan") return;
    expect(parsed.steps[0].model).toBeUndefined();
  });

  it("accepts a wave of exactly the maximum number of steps", () => {
    const steps = Array.from({ length: MAX_WAVE_STEPS }, (_, index) => ({
      role: "brigade",
      subtask: `Step ${index}`,
      access: [],
    }));
    const parsed = parseDistillWave(fence(JSON.stringify({ steps })));
    expect(parsed.kind).toBe("plan");
    if (parsed.kind !== "plan") return;
    expect(parsed.steps).toHaveLength(MAX_WAVE_STEPS);
  });

  it("ignores unknown extra keys on the plan and on a step", () => {
    const parsed = parseDistillWave(
      fence(
        '{"steps":[{"role":"qa","subtask":"Run","access":[],"notes":"hi"}],"version":2}',
      ),
    );
    expect(parsed.kind).toBe("plan");
    if (parsed.kind !== "plan") return;
    expect(parsed.steps[0]).toEqual({
      role: "qa",
      subtask: "Run",
      access: [],
    });
  });
});

describe("parseDistillWave — invalid", () => {
  it("rejects a body that is not JSON", () => {
    expectInvalid(fence("role: qa, subtask: run"), "malformed-json");
  });

  it("rejects a JSON array body", () => {
    expectInvalid(fence("[]"), "not-an-object");
  });

  it("rejects a missing steps array", () => {
    expectInvalid(fence('{"plan":"do things"}'), "steps-not-array");
  });

  it("rejects steps that are not an array", () => {
    expectInvalid(fence('{"steps":"qa"}'), "steps-not-array");
  });

  it("rejects an empty wave", () => {
    expectInvalid(fence('{"steps":[]}'), "steps-empty");
  });

  it("rejects more than the maximum number of steps", () => {
    const steps = Array.from({ length: MAX_WAVE_STEPS + 1 }, (_, index) => ({
      role: "brigade",
      subtask: `Step ${index}`,
      access: [],
    }));
    const parsed = expectInvalid(
      fence(JSON.stringify({ steps })),
      "too-many-steps",
    );
    expect(parsed?.detail).toContain(String(MAX_WAVE_STEPS));
  });

  it("rejects a step that is not an object", () => {
    const parsed = expectInvalid(
      fence('{"steps":["do the thing"]}'),
      "step-not-an-object",
    );
    expect(parsed?.stepIndex).toBe(0);
  });

  it("rejects a missing role", () => {
    expectInvalid(
      fence('{"steps":[{"subtask":"Run","access":[]}]}'),
      "role-not-a-string",
    );
  });

  it("rejects a non-string role", () => {
    expectInvalid(
      fence('{"steps":[{"role":3,"subtask":"Run","access":[]}]}'),
      "role-not-a-string",
    );
  });

  it("rejects an unknown role id", () => {
    const parsed = expectInvalid(
      fence('{"steps":[{"role":"wizard","subtask":"Run","access":[]}]}'),
      "role-unknown",
    );
    expect(parsed?.detail).toContain("wizard");
  });

  it("rejects a role that is not on the worker layer", () => {
    const parsed = expectInvalid(
      fence('{"steps":[{"role":"planner","subtask":"Run","access":[]}]}'),
      "role-not-worker-layer",
    );
    expect(parsed?.stepIndex).toBe(0);
  });

  it("rejects a non-string subtask", () => {
    expectInvalid(
      fence('{"steps":[{"role":"qa","subtask":42,"access":[]}]}'),
      "subtask-not-a-string",
    );
  });

  it("rejects a blank subtask", () => {
    expectInvalid(
      fence('{"steps":[{"role":"qa","subtask":"   ","access":[]}]}'),
      "subtask-empty",
    );
  });

  it("rejects a missing access field", () => {
    expectInvalid(
      fence('{"steps":[{"role":"qa","subtask":"Run"}]}'),
      "access-invalid",
    );
  });

  it("rejects a fine-grained access list", () => {
    const parsed = expectInvalid(
      fence('{"steps":[{"role":"qa","subtask":"Run","access":[0,1]}]}'),
      "access-invalid",
    );
    expect(parsed?.detail).toContain("all");
  });

  it("rejects an access string other than all", () => {
    expectInvalid(
      fence('{"steps":[{"role":"qa","subtask":"Run","access":"none"}]}'),
      "access-invalid",
    );
  });

  it("rejects a non-string model", () => {
    expectInvalid(
      fence(
        '{"steps":[{"role":"qa","subtask":"Run","access":[],"model":true}]}',
      ),
      "model-not-a-string",
    );
  });

  it("rejects a blank model string", () => {
    expectInvalid(
      fence(
        '{"steps":[{"role":"qa","subtask":"Run","access":[],"model":"  "}]}',
      ),
      "model-not-a-string",
    );
  });

  it("rejects a null model", () => {
    expectInvalid(
      fence(
        '{"steps":[{"role":"qa","subtask":"Run","access":[],"model":null}]}',
      ),
      "model-not-a-string",
    );
  });

  it("rejects two wave fences in one message", () => {
    const one = fence('{"steps":[{"role":"qa","subtask":"Run","access":[]}]}');
    const parsed = expectInvalid(`${one}\n\n${one}`, "multiple-fences");
    expect(parsed?.detail).toContain("2");
  });

  it("rejects an unterminated fence", () => {
    expectInvalid(
      '```distill-wave\n{"steps":[{"role":"qa","subtask":"Run","access":[]}]}',
      "unterminated-fence",
    );
  });

  it("reports the offending step index on the first bad step", () => {
    const parsed = expectInvalid(
      fence(
        '{"steps":[{"role":"qa","subtask":"Run","access":[]},{"role":"qa","subtask":"","access":[]}]}',
      ),
      "subtask-empty",
    );
    expect(parsed?.stepIndex).toBe(1);
  });
});

describe("parseWavePlanBody and parseWaveStep", () => {
  it("parses a bare plan body without a fence", () => {
    const parsed = parseWavePlanBody(
      '{"steps":[{"role":"qa","subtask":"Run","access":[]}]}',
    );
    expect(parsed.kind).toBe("plan");
  });

  it("validates a single step for the few-shot validator", () => {
    const step = parseWaveStep(
      { role: "writer", subtask: "Draft it", access: "all" },
      0,
    );
    expect(step).toEqual({
      role: "writer",
      subtask: "Draft it",
      access: "all",
    });
  });

  it("returns the enumerated reason for a single bad step", () => {
    const step = parseWaveStep(
      { role: "planner", subtask: "x", access: [] },
      2,
    );
    expect(step).toMatchObject({
      kind: "invalid",
      reason: "role-not-worker-layer",
      stepIndex: 2,
    });
  });
});

describe("scanFencedBlock", () => {
  it("returns the trimmed body and the surrounding prose", () => {
    const scan = scanFencedBlock("before\n```tag\nbody\n```\nafter", "tag");
    expect(scan).toEqual({
      kind: "one",
      body: "body",
      prose: "before\n\nafter",
    });
  });

  it("counts repeated fences", () => {
    const scan = scanFencedBlock("```tag\na\n```\n```tag\nb\n```", "tag");
    expect(scan).toEqual({ kind: "multiple", count: 2 });
  });

  it("reports no match and unterminated blocks", () => {
    expect(scanFencedBlock("plain text", "tag")).toEqual({ kind: "none" });
    expect(scanFencedBlock("```tag\nbody", "tag")).toEqual({
      kind: "unterminated",
    });
  });
});

describe("allowedWaveRoleIds", () => {
  it("lists worker-layer roles only", () => {
    expect(allowedWaveRoleIds()).toContain("brigade");
    expect(allowedWaveRoleIds()).not.toContain("planner");
  });
});
