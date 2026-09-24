import { describe, expect, it } from "vitest";
import {
  MAX_WAVE_STEPS,
  WAVE_FENCE_TAG,
  type WaveInvalidReason,
  parseDistillWave,
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

describe("parseDistillWave — plan", () => {
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

  it("keeps a step's effort and fast mode as their own fields, and a legacy folded model string as written", () => {
    const parsed = parseDistillWave(
      fence(
        '{"steps":[{"role":"qa","subtask":"Run the suite","access":[],"model":"gpt-5.6-sol","effort":" xhigh ","fast":false}]}',
      ),
    );
    expect(parsed.kind).toBe("plan");
    if (parsed.kind !== "plan") return;
    expect(parsed.steps[0]).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "xhigh",
      fast: false,
    });
    // A plan written before effort was a field keeps its model string as
    // written; the split happens where the model is resolved.
    const legacy = parseDistillWave(
      fence(
        '{"steps":[{"role":"qa","subtask":"Run","access":[],"model":"gpt-5.6-sol[xhigh]"}]}',
      ),
    );
    expect(legacy.kind === "plan" && legacy.steps[0]).toMatchObject({
      model: "gpt-5.6-sol[xhigh]",
    });
    expect(legacy.kind === "plan" && legacy.steps[0].effort).toBeUndefined();
  });
});

describe("parseDistillWave — invalid", () => {
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
});
