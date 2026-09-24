import { describe, expect, it } from "vitest";
import { WAVE_FENCE_TAG } from "./distillWave";
import {
  VERDICT_FENCE_TAG,
  type VerdictInvalidReason,
  parseDistillVerdict,
} from "./distillVerdict";

function verdictFence(body: string): string {
  return [`\`\`\`${VERDICT_FENCE_TAG}`, body, "```"].join("\n");
}

function waveFence(body: string): string {
  return [`\`\`\`${WAVE_FENCE_TAG}`, body, "```"].join("\n");
}

const REVISION_WAVE = waveFence(
  '{"steps":[{"role":"qa","subtask":"Re-run the failing suite","access":"all"}]}',
);

function expectInvalid(text: string, reason: VerdictInvalidReason) {
  const parsed = parseDistillVerdict(text);
  expect(parsed.kind).toBe("invalid");
  if (parsed.kind !== "invalid") return;
  expect(parsed.reason).toBe(reason);
  expect(parsed.detail.length).toBeGreaterThan(0);
  return parsed;
}

describe("parseDistillVerdict — accept", () => {
  it("parses an accept verdict with a note and keeps the prose", () => {
    const parsed = parseDistillVerdict(
      `Both steps landed.\n\n${verdictFence('{"verdict":"accept","note":"Shipped"}')}`,
    );
    expect(parsed.kind).toBe("verdict");
    if (parsed.kind !== "verdict") return;
    expect(parsed.verdict).toEqual({ outcome: "accept", note: "Shipped" });
    expect(parsed.prose).toBe("Both steps landed.");
  });
});

describe("parseDistillVerdict — revise", () => {
  it("parses a revise verdict together with its revision wave", () => {
    const parsed = parseDistillVerdict(
      `${verdictFence('{"verdict":"revise","note":"One suite still fails"}')}\n\n${REVISION_WAVE}`,
    );
    expect(parsed.kind).toBe("verdict");
    if (parsed.kind !== "verdict" || parsed.verdict.outcome !== "revise") {
      throw new Error("expected a revise verdict");
    }
    expect(parsed.verdict.note).toBe("One suite still fails");
    expect(parsed.verdict.steps).toEqual([
      { role: "qa", subtask: "Re-run the failing suite", access: "all" },
    ]);
    expect(parsed.prose).toBe("");
  });

  it("rejects a revise verdict with no wave to run", () => {
    expectInvalid(
      verdictFence('{"verdict":"revise"}'),
      "revision-wave-missing",
    );
  });
});

describe("parseDistillVerdict — invalid", () => {
  it("rejects a body that is not JSON", () => {
    expectInvalid(verdictFence("accept"), "malformed-json");
  });

  it("rejects an accept verdict that also ships a wave", () => {
    expectInvalid(
      `${verdictFence('{"verdict":"accept"}')}\n\n${REVISION_WAVE}`,
      "unexpected-revision-wave",
    );
  });

  it("rejects two verdict fences in one message", () => {
    const one = verdictFence('{"verdict":"accept"}');
    expectInvalid(`${one}\n\n${one}`, "multiple-fences");
  });

  it("rejects an unterminated verdict fence", () => {
    expectInvalid(
      '```distill-verdict\n{"verdict":"accept"}',
      "unterminated-fence",
    );
  });
});
