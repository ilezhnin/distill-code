import { describe, expect, it } from "vitest";

import { parseDistillVerdict } from "./distillVerdict";
import {
  MAX_WAVE_REVISIONS,
  decideWaveVerdict,
  digestUndeliverableDecision,
  isWaveLive,
  isWaveRetired,
} from "./waveVerdict";
import { createWaveState, withWavePhase, type WaveState } from "./waveEngine";
import type { StructuredReport } from "./types";

function parse(text: string) {
  return parseDistillVerdict(text);
}

function stepReport(over: Partial<StructuredReport> = {}): StructuredReport {
  return {
    runId: "run-verify",
    status: "completed",
    summary: "Ran the build and the tests",
    decisions: [],
    artifacts: [{ label: "build.log" }],
    risks: [],
    needsOperator: false,
    nextSuggestedTask: null,
    ...over,
  };
}

/**
 * A wave with nothing inspectable in it: no `prod`-stage role, so the E2
 * evidence gate does not apply and `accept` is the conductor's to give. Used
 * by every case that is about the verdict vocabulary rather than about
 * verification.
 */
function uncheckableWave(): WaveState {
  return createWaveState({
    waveId: "w-plain",
    conductorSessionId: "c1",
    planMessageId: "plan-1",
    steps: [{ role: "researcher", subtask: "Read the docs", access: [] }],
    createdAt: 1,
  });
}

/** `decideWaveVerdict` over a wave the evidence gate has no opinion about. */
function decide(input: {
  parse: ReturnType<typeof parseDistillVerdict>;
  revisionCount: number;
  maxRevisions?: number;
  wave?: WaveState;
  reportOf?: (runId: string | null | undefined) => StructuredReport | undefined;
}) {
  return decideWaveVerdict({
    ...input,
    wave: input.wave ?? uncheckableWave(),
    reportOf: input.reportOf ?? (() => undefined),
  });
}

function verdictFence(body: string): string {
  return `Here is my read.\n\n\`\`\`distill-verdict\n${body}\n\`\`\``;
}

const REVISION_WAVE = `\n\n\`\`\`distill-wave\n{"steps":[{"role":"scout","subtask":"Look again, this time at the tests","access":"all"}]}\n\`\`\``;

describe("decideWaveVerdict", () => {
  it("closes the wave on accept and offers no retry", () => {
    const decision = decide({
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
    const decision = decide({
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
    const decision = decide({
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
    const decision = decide({
      parse: parse(verdictFence('{"verdict":"revise"}') + REVISION_WAVE),
      revisionCount: 1,
    });
    expect(decision.phase).toBe("revised");
    expect(decision.revision?.revisionIndex).toBe(2);
  });

  it("refuses a third revision — the cap is 2 per root request", () => {
    expect(MAX_WAVE_REVISIONS).toBe(2);
    const decision = decide({
      parse: parse(verdictFence('{"verdict":"revise"}') + REVISION_WAVE),
      revisionCount: MAX_WAVE_REVISIONS,
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure?.reason).toBe("revision-cap-reached");
    expect(decision.revision).toBeUndefined();
    expect(decision.offerRetry).toBe(false);
  });

  it("goes straight to needsOperator when there is no verdict fence (Q5)", () => {
    const decision = decide({
      parse: parse("Looks good to me, nice work everyone."),
      revisionCount: 0,
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure?.reason).toBe("verdict-missing");
    expect(decision.offerRetry).toBe(true);
  });

  it("goes straight to needsOperator on an unreadable verdict (Q5)", () => {
    const decision = decide({
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
    const decision = decide({
      parse: parse("no fence here"),
      revisionCount: MAX_WAVE_REVISIONS - 1,
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.revision).toBeUndefined();
    // Nothing in the decision increments the count; the wave keeps its own.
    const afterRetry = decide({
      parse: parse(verdictFence('{"verdict":"revise"}') + REVISION_WAVE),
      revisionCount: MAX_WAVE_REVISIONS - 1,
    });
    expect(afterRetry.phase).toBe("revised");
    expect(afterRetry.revision?.revisionIndex).toBe(MAX_WAVE_REVISIONS);
  });

  it("rejects a revise verdict whose wave does not parse", () => {
    const decision = decide({
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

describe("the E3b artifact check on accept (P11)", () => {
  const ACCEPT = '{"verdict":"accept","note":"Shipped."}';

  it("honours accept when the app found every named file", () => {
    const wave = { ...uncheckableWave(), checkedArtifacts: 3 };
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: 0,
      wave,
    });
    expect(decision.phase).toBe("accepted");
  });

  it("parks accept when a report named a file that is not on disk", () => {
    // The whole point of E3b: this report passes E2 — a verification step
    // that completed and listed artifacts — and is still lying about them.
    const wave = {
      ...uncheckableWave(),
      checkedArtifacts: 2,
      missingArtifacts: ["src/features/net/retry.ts"],
    };
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: 0,
      wave,
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure?.reason).toBe("accepted-with-missing-artifacts");
    expect(decision.closure?.detail).toContain("src/features/net/retry.ts");
    // Same reasoning as E2: the same conductor answers the same question the
    // same way, so a retry would only spend a model call.
    expect(decision.offerRetry).toBe(false);
  });

  it("keeps the conductor's note beside the refusal", () => {
    const wave = {
      ...uncheckableWave(),
      checkedArtifacts: 1,
      missingArtifacts: ["docs/report.md"],
    };
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: 0,
      wave,
    });
    expect(decision.closure?.note).toBe("Shipped.");
  });

  it("names a bounded number of missing paths and counts the rest", () => {
    const missing = Array.from({ length: 8 }, (_, i) => `out/file-${i}.txt`);
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: 0,
      wave: {
        ...uncheckableWave(),
        checkedArtifacts: 8,
        missingArtifacts: missing,
      },
    });
    expect(decision.closure?.detail).toContain("out/file-0.txt");
    expect(decision.closure?.detail).toContain("and 3 more");
    expect(decision.closure?.detail).not.toContain("out/file-7.txt");
  });

  it("changes nothing when the check never ran", () => {
    // A probe that could not run (no Tauri, no reported paths, a timeout) is
    // an infrastructure failure, and reading it as "the worker lied" would
    // make every degraded build refuse every accept.
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: 0,
      wave: uncheckableWave(),
    });
    expect(decision.phase).toBe("accepted");
  });

  it("does not rescue a wave that failed the evidence gate first", () => {
    // Order matters: "nobody checked" is the bigger fact, and a passing path
    // check must not explain it away.
    const wave = createWaveState({
      waveId: "w-build",
      conductorSessionId: "c1",
      planMessageId: "plan-1",
      steps: [
        { role: "writer", subtask: "Write the module", access: [] },
        { role: "writer", subtask: "Write the other module", access: [] },
      ],
      createdAt: 1,
    });
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: 0,
      wave: { ...wave, checkedArtifacts: 4 },
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure?.reason).toBe("accepted-without-evidence");
  });
});

describe("the E2 evidence gate on accept", () => {
  const ACCEPT = '{"verdict":"accept","note":"Shipped."}';

  /**
   * A checkable wave: a `prod`-stage worker builds something, and the last
   * step is the `verify`-stage acceptor that is supposed to look at it.
   */
  function checkableWave(
    over: {
      verifierRole?: string;
      verifierAccess?: readonly [] | "all";
      verifierRunId?: string;
    } = {},
  ): WaveState {
    const wave = createWaveState({
      waveId: "w-build",
      conductorSessionId: "c1",
      planMessageId: "plan-1",
      steps: [
        { role: "writer", subtask: "Write the module", access: [] },
        {
          role: over.verifierRole ?? "acceptor",
          subtask: "Run the build and check the file is there",
          access: over.verifierAccess ?? "all",
        },
      ],
      createdAt: 1,
    });
    return {
      ...wave,
      steps: wave.steps.map((step, index) =>
        index === 1
          ? {
              ...step,
              phase: "spawned",
              runId: over.verifierRunId ?? "run-verify",
            }
          : { ...step, phase: "spawned", runId: `run-${index}` },
      ),
    };
  }

  it("honours accept when the verification step actually produced evidence", () => {
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: 0,
      wave: checkableWave(),
      reportOf: (runId) => (runId === "run-verify" ? stepReport() : undefined),
    });
    expect(decision.phase).toBe("accepted");
    expect(decision.closure?.reason).toBe("accepted");
  });

  it("downgrades accept when the wave never had a verification step", () => {
    // The plan lint (E1) refuses these now, but a wave admitted by an older
    // build — or a revision the conductor reshaped — can still be sitting in
    // localStorage, and `accept` is the decision that must not be honoured.
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: 0,
      wave: checkableWave({ verifierRole: "brigade" }),
      reportOf: () => stepReport(),
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure?.reason).toBe("accepted-without-evidence");
    // The conductor's own note survives: the operator still reads what it said.
    expect(decision.closure?.note).toBe("Shipped.");
    expect(decision.offerRetry).toBe(false);
  });

  it("downgrades accept when the verifier could not read the earlier steps", () => {
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: 0,
      wave: checkableWave({ verifierAccess: [] }),
      reportOf: () => stepReport(),
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure?.reason).toBe("accepted-without-evidence");
  });

  it("downgrades accept when the verification step never reported", () => {
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: 0,
      wave: checkableWave(),
      reportOf: () => undefined,
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure?.detail).toContain("did not complete");
  });

  it("downgrades accept when the verification step itself failed", () => {
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: 0,
      wave: checkableWave(),
      reportOf: (runId) =>
        runId === "run-verify" ? stepReport({ status: "failed" }) : undefined,
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure?.reason).toBe("accepted-without-evidence");
  });

  it("downgrades accept when the verifier reported nothing it looked at", () => {
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: 0,
      wave: checkableWave(),
      reportOf: (runId) =>
        runId === "run-verify" ? stepReport({ artifacts: [] }) : undefined,
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure?.detail).toContain("no artifacts");
  });

  it("leaves an uncheckable wave's accept alone", () => {
    // Nothing here builds anything: research, then a summary of the research.
    const wave = createWaveState({
      waveId: "w-read",
      conductorSessionId: "c1",
      planMessageId: "plan-1",
      steps: [
        { role: "researcher", subtask: "Read the RFCs", access: [] },
        { role: "oracle", subtask: "Answer the question", access: "all" },
      ],
      createdAt: 1,
    });
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: 0,
      wave,
      reportOf: () => undefined,
    });
    expect(decision.phase).toBe("accepted");
  });

  it("does not gate revise or needs-operator", () => {
    // Only `accept` claims the work is done; the other two are already the
    // operator's problem, and blocking them would strand the wave.
    const revise = decide({
      parse: parse(verdictFence('{"verdict":"revise"}') + REVISION_WAVE),
      revisionCount: 0,
      wave: checkableWave({ verifierRole: "brigade" }),
      reportOf: () => undefined,
    });
    expect(revise.phase).toBe("revised");
    const needsOperator = decide({
      parse: parse(verdictFence('{"verdict":"needs-operator"}')),
      revisionCount: 0,
      wave: checkableWave({ verifierRole: "brigade" }),
      reportOf: () => undefined,
    });
    expect(needsOperator.closure?.reason).toBe("conductor-needs-operator");
  });
});

describe("digestUndeliverableDecision", () => {
  it("parks the wave with the dispatch reason", () => {
    const decision = digestUndeliverableDecision('No session "c-1".');
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure).toEqual({
      reason: "digest-undeliverable",
      detail: 'No session "c-1".',
    });
  });

  it("offers the retry (P17)", () => {
    // Of every failure that parks a wave this is the one most worth asking
    // again about: nothing went wrong with the reasoning, a send failed. The
    // wave is finished and its reports exist, so the button re-delivers the
    // same digest under a new attempt marker. Without it, a whole wave's work
    // was lost to one bad send.
    expect(digestUndeliverableDecision("socket closed").offerRetry).toBe(true);
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

describe("isWaveLive", () => {
  const base = createWaveState({
    waveId: "w1",
    conductorSessionId: "c1",
    planMessageId: "plan-1",
    steps: [{ role: "scout", subtask: "Look", access: [] }],
    createdAt: 1,
  });

  it("covers every phase that still owes the operator something", () => {
    for (const phase of [
      "running",
      "digestPending",
      "dispatchingDigest",
      "awaitingVerdict",
    ] as const) {
      expect(isWaveLive(withWavePhase(base, phase))).toBe(true);
    }
  });

  it("does not count a closed or parked wave as live", () => {
    // A parked wave is a record backing the retry, not work in flight: a new
    // root request may replace it, and already does.
    for (const phase of ["accepted", "revised", "needsOperator"] as const) {
      expect(isWaveLive(withWavePhase(base, phase))).toBe(false);
    }
  });
});
