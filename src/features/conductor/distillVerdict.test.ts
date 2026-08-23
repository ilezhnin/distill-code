import { describe, expect, it } from "vitest";
import { WAVE_FENCE_TAG } from "./distillWave";
import {
  VERDICT_FENCE_TAG,
  VERDICT_TOKENS,
  VERDICT_TOKEN_VALUES,
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

describe("verdict vocabulary", () => {
  it("fixes the three tokens once", () => {
    expect(VERDICT_TOKENS).toEqual({
      accept: "accept",
      revise: "revise",
      needsOperator: "needs-operator",
    });
    expect(VERDICT_TOKEN_VALUES).toEqual([
      "accept",
      "revise",
      "needs-operator",
    ]);
  });
});

describe("parseDistillVerdict — none", () => {
  it("reports no verdict when the message carries neither fence", () => {
    expect(parseDistillVerdict("Looks fine to me.")).toEqual({ kind: "none" });
  });

  it("ignores an unrelated fenced block", () => {
    expect(parseDistillVerdict('```json\n{"verdict":"accept"}\n```')).toEqual({
      kind: "none",
    });
  });
});

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

  it("parses an accept verdict without a note", () => {
    const parsed = parseDistillVerdict(verdictFence('{"verdict":"accept"}'));
    expect(parsed.kind).toBe("verdict");
    if (parsed.kind !== "verdict") return;
    expect(parsed.verdict).toEqual({ outcome: "accept" });
  });

  it("drops a blank note", () => {
    const parsed = parseDistillVerdict(
      verdictFence('{"verdict":"accept","note":"   "}'),
    );
    expect(parsed.kind).toBe("verdict");
    if (parsed.kind !== "verdict") return;
    expect(parsed.verdict).toEqual({ outcome: "accept" });
  });

  it("treats an explicit null note as absent", () => {
    const parsed = parseDistillVerdict(
      verdictFence('{"verdict":"accept","note":null}'),
    );
    expect(parsed.kind).toBe("verdict");
    if (parsed.kind !== "verdict") return;
    expect(parsed.verdict).toEqual({ outcome: "accept" });
  });
});

describe("parseDistillVerdict — needs-operator", () => {
  it("parses a needs-operator verdict with its note", () => {
    const parsed = parseDistillVerdict(
      verdictFence('{"verdict":"needs-operator","note":"No credentials"}'),
    );
    expect(parsed.kind).toBe("verdict");
    if (parsed.kind !== "verdict") return;
    expect(parsed.verdict).toEqual({
      outcome: "needs-operator",
      note: "No credentials",
    });
  });

  it("does not accept a camelCase spelling of the token", () => {
    expectInvalid(
      verdictFence('{"verdict":"needsOperator"}'),
      "verdict-unknown",
    );
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

  it("reads a bare wave fence as a revision wave", () => {
    const parsed = parseDistillVerdict(`Not there yet.\n\n${REVISION_WAVE}`);
    expect(parsed.kind).toBe("verdict");
    if (parsed.kind !== "verdict" || parsed.verdict.outcome !== "revise") {
      throw new Error("expected a revise verdict");
    }
    expect(parsed.verdict.steps).toHaveLength(1);
    expect(parsed.verdict.note).toBeUndefined();
    expect(parsed.prose).toBe("Not there yet.");
  });

  it("rejects a revise verdict with no wave to run", () => {
    expectInvalid(
      verdictFence('{"verdict":"revise"}'),
      "revision-wave-missing",
    );
  });

  it("rejects a revise verdict whose wave does not parse", () => {
    const parsed = expectInvalid(
      `${verdictFence('{"verdict":"revise"}')}\n\n${waveFence(
        '{"steps":[{"role":"planner","subtask":"Re-plan","access":[]}]}',
      )}`,
      "revision-wave-invalid",
    );
    expect(parsed?.waveReason).toBe("role-not-worker-layer");
  });

  it("rejects a bare wave fence that does not parse", () => {
    const parsed = expectInvalid(
      waveFence('{"steps":[]}'),
      "revision-wave-invalid",
    );
    expect(parsed?.waveReason).toBe("steps-empty");
  });
});

describe("parseDistillVerdict — invalid", () => {
  it("rejects a body that is not JSON", () => {
    expectInvalid(verdictFence("accept"), "malformed-json");
  });

  it("rejects a JSON array body", () => {
    expectInvalid(verdictFence('["accept"]'), "not-an-object");
  });

  it("rejects a missing verdict field", () => {
    expectInvalid(verdictFence('{"note":"all good"}'), "verdict-not-a-string");
  });

  it("rejects a non-string verdict field", () => {
    expectInvalid(verdictFence('{"verdict":true}'), "verdict-not-a-string");
  });

  it("rejects an unknown verdict token", () => {
    const parsed = expectInvalid(
      verdictFence('{"verdict":"retry"}'),
      "verdict-unknown",
    );
    expect(parsed?.detail).toContain("retry");
  });

  it("rejects a non-string note", () => {
    expectInvalid(
      verdictFence('{"verdict":"accept","note":12}'),
      "note-not-a-string",
    );
  });

  it("rejects an accept verdict that also ships a wave", () => {
    expectInvalid(
      `${verdictFence('{"verdict":"accept"}')}\n\n${REVISION_WAVE}`,
      "unexpected-revision-wave",
    );
  });

  it("rejects a needs-operator verdict that also ships a wave", () => {
    expectInvalid(
      `${verdictFence('{"verdict":"needs-operator"}')}\n\n${REVISION_WAVE}`,
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
