import { describe, expect, it } from "vitest";

import { parseFlockVerdict } from "./flockVerdict";
import { MAX_WAVE_REVISIONS, decideWaveVerdict } from "./waveVerdict";
import { createWaveState, type WaveState } from "./waveEngine";
import type { StructuredReport } from "./types";

function parse(text: string) {
  return parseFlockVerdict(text);
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
  parse: ReturnType<typeof parseFlockVerdict>;
  revisionCount: number;
  maxRevisions?: number;
  wave?: WaveState;
  reportOf?: (runId: string | null | undefined) => StructuredReport | undefined;
  /** The conductor was already asked again about a refused accept. */
  reasked?: boolean;
}) {
  const { reasked, ...rest } = input;
  const wave = input.wave ?? uncheckableWave();
  return decideWaveVerdict({
    ...rest,
    wave: reasked
      ? { ...wave, verdictIssue: { reason: "accept-refused" } }
      : wave,
    reportOf: input.reportOf ?? (() => undefined),
  });
}

function verdictFence(body: string): string {
  return `Here is my read.\n\n\`\`\`distill-verdict\n${body}\n\`\`\``;
}

const REVISION_WAVE = `\n\n\`\`\`distill-wave\n{"steps":[{"role":"scout","subtask":"Look again, this time at the tests","access":"all"}]}\n\`\`\``;

describe("decideWaveVerdict", () => {
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
});

describe("the E3b artifact check on accept (P11)", () => {
  const ACCEPT = '{"verdict":"accept","note":"Shipped."}';

  const missingFileWave = (): WaveState => ({
    ...uncheckableWave(),
    checkedArtifacts: 2,
    missingArtifacts: ["src/features/net/retry.ts"],
  });

  it("asks the conductor again, with the missing file, the first time", () => {
    // Told nothing, the conductor believed the wave closed and sat idle.
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: 0,
      wave: missingFileWave(),
    });
    expect(decision.phase).toBe("digestPending");
    expect(decision.closure).toBeUndefined();
    expect(decision.reasked?.reason).toBe("accepted-with-missing-artifacts");
    expect(decision.verdictIssue).toMatchObject({ reason: "accept-refused" });
    expect(decision.verdictIssue?.detail).toContain(
      "src/features/net/retry.ts",
    );
  });

  it("parks a second accept of the same digest for the operator", () => {
    // The whole point of E3b: this report passes E2 — a verification step
    // that completed and listed artifacts — and is still lying about them.
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: 0,
      reasked: true,
      wave: missingFileWave(),
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure?.reason).toBe("accepted-with-missing-artifacts");
    expect(decision.closure?.detail).toContain("src/features/net/retry.ts");
    // Asked once with the reason and accepted again: the same conductor
    // answers the same question the same way, so the operator decides.
    expect(decision.offerRetry).toBe(false);
  });

  it("parks at once when no revision is left to spend on the fix", () => {
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: MAX_WAVE_REVISIONS,
      wave: missingFileWave(),
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure?.reason).toBe("accepted-with-missing-artifacts");
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

  it("asks the conductor again when nothing verified the wave, the first time", () => {
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: 0,
      wave: checkableWave(),
      reportOf: (runId) =>
        runId === "run-verify" ? stepReport({ status: "failed" }) : undefined,
    });
    expect(decision.phase).toBe("digestPending");
    expect(decision.reasked?.reason).toBe("accepted-without-evidence");
    expect(decision.verdictIssue?.detail).toContain("did not complete");
  });

  it("downgrades accept when the wave never had a verification step", () => {
    // The plan lint (E1) refuses these now, but a wave admitted by an older
    // build — or a revision the conductor reshaped — can still be sitting in
    // localStorage, and `accept` is the decision that must not be honoured.
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: 0,
      reasked: true,
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
      reasked: true,
      wave: checkableWave({ verifierAccess: [] }),
      reportOf: () => stepReport(),
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure?.reason).toBe("accepted-without-evidence");
  });

  it("downgrades accept when the verification step itself failed", () => {
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: 0,
      reasked: true,
      wave: checkableWave(),
      reportOf: (runId) =>
        runId === "run-verify" ? stepReport({ status: "failed" }) : undefined,
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure?.reason).toBe("accepted-without-evidence");
  });

  it("downgrades accept when the verifier's report was quarantined", () => {
    const wave = checkableWave();
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: 0,
      reasked: true,
      wave: {
        ...wave,
        steps: wave.steps.map((step) =>
          step.stepIndex === 1
            ? {
                ...step,
                reportVerified: true,
                verificationFailed: true,
                verificationDetail: "the report's summary is empty",
              }
            : step,
        ),
      },
      reportOf: (runId) => (runId === "run-verify" ? stepReport() : undefined),
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure?.reason).toBe("accepted-without-evidence");
    expect(decision.closure?.detail).toContain("quarantined");
  });

  it("downgrades accept when the verifier reported nothing it looked at", () => {
    const decision = decide({
      parse: parse(verdictFence(ACCEPT)),
      revisionCount: 0,
      reasked: true,
      wave: checkableWave(),
      reportOf: (runId) =>
        runId === "run-verify" ? stepReport({ artifacts: [] }) : undefined,
    });
    expect(decision.phase).toBe("needsOperator");
    expect(decision.closure?.detail).toContain("no artifacts");
  });
});
