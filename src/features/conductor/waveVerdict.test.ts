import { describe, expect, it } from "vitest";

import { parseDistillVerdict } from "./distillVerdict";
import {
  MAX_WAVE_REVISIONS,
  decideWaveVerdict,
  digestUndeliverableDecision,
  isWaveRetired,
} from "./waveVerdict";
import { createWaveState, withWavePhase } from "./waveEngine";

function parse(text: string) {
  return parseDistillVerdict(text);
}

function verdictFence(body: string): string {
  return `Here is my read.\n\n\`\`\`distill-verdict\n${body}\n\`\`\``;
}

const REVISION_WAVE = `\n\n\`\`\`distill-wave\n{"steps":[{"role":"scout","subtask":"Look again, this time at the tests","access":"all"}]}\n\`\`\``;

describe("decideWaveVerdict", () => {
  it("closes the wave on accept and offers no retry", () => {
    const decision = decideWaveVerdict({
      parse: parse(verdictFence('{"verdict":"accept","note":"Both landed."}')),
      revisionCount: 0,
    });
    expect(decision.phase).toBe("accepted");
    expect(decision.closure).toEqual({
      reason: "accepted",
      note: "Both landed.",
    });
    expect(decision.revision).toBeUndefined();
    expect(decision.offerRetry).toBe(false);
  });

  it("hands the request back on needs-operator, carrying the note", () => {
    const decision = decideWaveVerdict({
      parse: parse(
        verdictFence(
          '{"verdict":"needs-operator","note":"I need the API key."}',
        ),
      ),
      revisionCount: 0,
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure).toEqual({
      reason: "conductor-needs-operator",
      note: "I need the API key.",
    });
    // The conductor decided this deliberately; asking it again would repeat it.
    expect(decision.offerRetry).toBe(false);
  });

  it("asks for one revision wave and numbers it", () => {
    const decision = decideWaveVerdict({
      parse: parse(verdictFence('{"verdict":"revise"}') + REVISION_WAVE),
      revisionCount: 0,
    });
    expect(decision.phase).toBe("revised");
    expect(decision.revision?.revisionIndex).toBe(1);
    expect(decision.revision?.steps).toHaveLength(1);
    // A revision posts nothing to the operator; the transcript already shows it.
    expect(decision.closure).toBeUndefined();
  });

  it("numbers the second revision and still allows it", () => {
    const decision = decideWaveVerdict({
      parse: parse(verdictFence('{"verdict":"revise"}') + REVISION_WAVE),
      revisionCount: 1,
    });
    expect(decision.phase).toBe("revised");
    expect(decision.revision?.revisionIndex).toBe(2);
  });

  it("refuses a third revision — the cap is 2 per root request", () => {
    expect(MAX_WAVE_REVISIONS).toBe(2);
    const decision = decideWaveVerdict({
      parse: parse(verdictFence('{"verdict":"revise"}') + REVISION_WAVE),
      revisionCount: MAX_WAVE_REVISIONS,
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure?.reason).toBe("revision-cap-reached");
    expect(decision.revision).toBeUndefined();
    expect(decision.offerRetry).toBe(false);
  });

  it("goes straight to needsOperator when there is no verdict fence (Q5)", () => {
    const decision = decideWaveVerdict({
      parse: parse("Looks good to me, nice work everyone."),
      revisionCount: 0,
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure?.reason).toBe("verdict-missing");
    expect(decision.offerRetry).toBe(true);
  });

  it("goes straight to needsOperator on an unreadable verdict (Q5)", () => {
    const decision = decideWaveVerdict({
      parse: parse(verdictFence('{"verdict":"looks-fine"}')),
      revisionCount: 0,
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure?.reason).toBe("verdict-invalid");
    expect(decision.closure?.detail).toContain("looks-fine");
    expect(decision.offerRetry).toBe(true);
  });

  it("does not spend a revision on an unreadable verdict", () => {
    // The cap is already at its last slot. An unreadable answer must not eat
    // it: the operator retries and the conductor still gets its revision.
    const decision = decideWaveVerdict({
      parse: parse("no fence here"),
      revisionCount: MAX_WAVE_REVISIONS - 1,
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.revision).toBeUndefined();
    // Nothing in the decision increments the count; the wave keeps its own.
    const afterRetry = decideWaveVerdict({
      parse: parse(verdictFence('{"verdict":"revise"}') + REVISION_WAVE),
      revisionCount: MAX_WAVE_REVISIONS - 1,
    });
    expect(afterRetry.phase).toBe("revised");
    expect(afterRetry.revision?.revisionIndex).toBe(MAX_WAVE_REVISIONS);
  });

  it("rejects a revise verdict whose wave does not parse", () => {
    const decision = decideWaveVerdict({
      parse: parse(
        `${verdictFence('{"verdict":"revise"}')}\n\n\`\`\`distill-wave\n{oops\n\`\`\``,
      ),
      revisionCount: 0,
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure?.reason).toBe("verdict-invalid");
    expect(decision.offerRetry).toBe(true);
  });
});

describe("digestUndeliverableDecision", () => {
  it("parks the wave with the dispatch reason and no retry", () => {
    const decision = digestUndeliverableDecision('No session "c-1".');
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure).toEqual({
      reason: "digest-undeliverable",
      detail: 'No session "c-1".',
    });
    expect(decision.offerRetry).toBe(false);
  });
});

describe("isWaveRetired", () => {
  const base = createWaveState({
    waveId: "w1",
    conductorSessionId: "c1",
    planMessageId: "plan-1",
    steps: [{ role: "scout", subtask: "Look", access: [] }],
    createdAt: 1,
  });

  it("retires accepted and revised waves", () => {
    expect(isWaveRetired(withWavePhase(base, "accepted"))).toBe(true);
    expect(isWaveRetired(withWavePhase(base, "revised"))).toBe(true);
  });

  it("keeps a wave parked on needsOperator so the retry can find it", () => {
    expect(isWaveRetired(withWavePhase(base, "needsOperator"))).toBe(false);
    expect(isWaveRetired(base)).toBe(false);
  });
});
