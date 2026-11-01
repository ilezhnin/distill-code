import { describe, expect, it } from "vitest";

import { i18n } from "@/shared/i18n";

import type { WaveStep } from "./flockWave";
import { RUN_FALLBACK_SUMMARIES } from "./orchestratorReport";
import { waveRejectionNoticeText } from "./waveNotices";
import { parseWaveEngineState } from "./waveStore";
import type { RunStatus, SessionNode, StructuredReport } from "./types";
import {
  UNSTARTED_STEP_REPORT_SUMMARY,
  admitWavePlan,
  advanceWave,
  createWaveState,
  hasAttestedWaveStepReport,
  waveInterruptedBeforeReport,
  withWaveStepPhase,
  type WaveState,
} from "./waveEngine";

function step(
  role: string,
  subtask: string,
  access: WaveStep["access"] = [],
  model?: string,
): WaveStep {
  return { role, subtask, access, ...(model ? { model } : {}) };
}

function waveOf(steps: readonly WaveStep[]): WaveState {
  return createWaveState({
    waveId: "wave-1",
    conductorSessionId: "conductor-1",
    planMessageId: "plan-1",
    steps,
    createdAt: 1,
  });
}

function workerNode(stepIndex: number, status: RunStatus): SessionNode {
  return {
    sessionId: `child-${stepIndex}`,
    projectId: "project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: `run-${stepIndex}`,
    harnessId: "goose",
    displayName: `Worker ${stepIndex}`,
    status,
    waveId: "wave-1",
    stepIndex,
  };
}

function report(runId: string, summary: string): StructuredReport {
  return {
    runId,
    status: "completed",
    summary,
    decisions: [],
    artifacts: [],
    risks: [],
    needsOperator: false,
    nextSuggestedTask: null,
  };
}

const noReports = () => undefined;

describe("admitWavePlan", () => {
  it("refuses the whole plan when a step's effort or fast mode fails the live check", async () => {
    const checked: string[] = [];
    const admission = admitWavePlan(
      {
        kind: "plan",
        planText: "",
        prose: "",
        steps: [
          step("scout", "Find the callers"),
          { ...step("qa", "Write the test plan"), effort: "ultra" },
        ],
      },
      {
        checkStepRunSettings: (candidate) => {
          checked.push(candidate.role);
          return candidate.effort
            ? {
                ok: false,
                detail: `The model "Opus 5" does not offer the reasoning effort "${candidate.effort}"; it offers low, high.`,
              }
            : { ok: true };
        },
      },
    );
    expect(checked).toEqual(["scout", "qa"]);
    expect(admission).toMatchObject({
      kind: "rejected",
      reason: "step-run-settings-unavailable",
      stepIndex: 1,
    });
    if (admission.kind !== "rejected") return;
    await i18n.loadNamespaces("chat");
    const card = waveRejectionNoticeText({
      reason: admission.reason,
      detail: admission.detail,
      stepIndex: admission.stepIndex,
    });
    expect(card).toContain("it offers low, high");
  });
});

/**
 * E1. The protocol prompt has told the conductor to end a checkable wave with
 * a verification step since `81b29ef`, and nothing read that instruction: a
 * four-step wave of pure builders was admitted and ran, and its `accept` was
 * honoured on nobody's evidence. This is the floor under the prompt — narrow
 * on purpose, because a false refusal costs one replan while an unverified
 * accept costs a wrong answer the operator believes.
 */
describe("the E1 verification lint", () => {
  function plan(steps: readonly WaveStep[]) {
    return admitWavePlan({
      kind: "plan",
      planText: "",
      prose: "",
      steps: [...steps],
    });
  }

  it("refuses a wave that builds something and never inspects it", () => {
    const admission = plan([
      step("writer", "Write the migration guide"),
      step("brigade", "Update the callers", "all"),
    ]);
    expect(admission).toMatchObject({
      kind: "rejected",
      reason: "verification-step-missing",
      stepIndex: 1,
    });
    if (admission.kind !== "rejected") return;
    expect(admission.detail).toContain("acceptor");
  });

  it("refuses a verifier that cannot see what it is verifying", () => {
    // `access: []` means the step never receives the earlier reports, so it
    // does not know what was built. It is a verification step in name only.
    const admission = plan([
      step("brigade", "Update the callers"),
      step("acceptor", "Check the work"),
    ]);
    expect(admission).toMatchObject({
      kind: "rejected",
      reason: "verification-step-blind",
      stepIndex: 1,
    });
    if (admission.kind !== "rejected") return;
    // The defect it names is the one it has: access, not a missing step.
    expect(admission.detail).toContain('"access":"all"');
  });

  /**
   * The live failure this split came from: build, build, verify, commit was
   * refused as "its last step does not check it" while its acceptor sat at
   * step 3. The rule the engine means is that the last step which *inspects*
   * is the verifier — release work acts on what that step already checked.
   */
  it("lets a commit step trail the verifier", () => {
    expect(
      plan([
        step("brigade", "Fix the shell tails"),
        step("brigade", "Fix the fallback glyph"),
        step("acceptor", "Build, test, and read the diff yourself", "all"),
        step("pr-submitter", "Commit what acceptance confirmed", "all"),
      ]).kind,
    ).toBe("accepted");
  });

  it("refuses a builder that runs after the verifier, release tail or not", () => {
    expect(
      plan([
        step("brigade", "Update the callers"),
        step("acceptor", "Check it", "all"),
        step("brigade", "One more fix nobody checks"),
        step("pr-submitter", "Commit it", "all"),
      ]),
    ).toMatchObject({
      kind: "rejected",
      reason: "verification-step-misplaced",
      stepIndex: 2,
    });
  });
});

describe("advanceWave scheduling", () => {
  it("spawns every access:[] step at once", () => {
    const wave = waveOf([
      step("scout", "one"),
      step("qa", "two"),
      step("brigade", "three"),
    ]);
    const advanced = advanceWave(wave, { nodes: [], reportOf: noReports });
    expect(advanced.spawn.map((request) => request.stepIndex)).toEqual([
      0, 1, 2,
    ]);
    expect(advanced.spawn.every((r) => r.previousReports.length === 0)).toBe(
      true,
    );
    expect(advanced.spawn[0].totalSteps).toBe(3);
    expect(advanced.complete).toBe(false);
  });

  it("holds an access:all step until every earlier step is terminal", () => {
    const wave = withWaveStepPhase(
      withWaveStepPhase(
        waveOf([step("scout", "one"), step("qa", "two", "all")]),
        0,
        {
          phase: "spawned",
          sessionId: "child-0",
          runId: "run-0",
        },
      ),
      1,
      { phase: "pending" },
    );

    const running = advanceWave(wave, {
      nodes: [workerNode(0, "running")],
      reportOf: noReports,
    });
    expect(running.spawn).toHaveLength(0);

    const done = advanceWave(wave, {
      nodes: [workerNode(0, "completed")],
      reportOf: (runId) =>
        runId === "run-0" ? report("run-0", "Found three callers") : undefined,
    });
    expect(done.spawn.map((request) => request.stepIndex)).toEqual([1]);
    expect(done.spawn[0].previousReports).toEqual([
      {
        stepIndex: 0,
        role: "scout",
        subtask: "one",
        report: report("run-0", "Found three callers"),
      },
    ]);
  });

  it("surfaces a blocked report and schedules nothing on top of it", () => {
    // §5 risk 9: the cheapest response to "this step cannot be done" is to
    // stop the wave. The engine finds the blocked step; the shell stops the
    // wave the way the operator's stop does.
    const wave = withWaveStepPhase(
      waveOf([step("scout", "one"), step("qa", "two", "all")]),
      0,
      { phase: "spawned", sessionId: "child-0", runId: "run-0" },
    );
    const blockedReport: StructuredReport = {
      ...report("run-0", "Could not start"),
      status: "blocked",
      reason: "the file the subtask names does not exist",
      needsOperator: true,
    };
    const advanced = advanceWave(wave, {
      nodes: [workerNode(0, "completed")],
      reportOf: (runId) => (runId === "run-0" ? blockedReport : undefined),
    });
    expect(advanced.blocked).toEqual([
      { stepIndex: 0, reason: "the file the subtask names does not exist" },
    ]);
    // The satisfied access:"all" successor is NOT requested…
    expect(advanced.spawn).toEqual([]);
    // …and the wave never declares itself complete: `digestPending` is the
    // door to a digest and a verdict, and a blocked wave gets neither (5b).
    expect(advanced.complete).toBe(false);
  });

  it("treats a step whose spawn threw as terminal and reports it as unstarted", () => {
    const wave = withWaveStepPhase(
      waveOf([step("scout", "one"), step("qa", "two", "all")]),
      0,
      { phase: "failed" },
    );
    const advanced = advanceWave(wave, { nodes: [], reportOf: noReports });
    expect(advanced.spawn.map((request) => request.stepIndex)).toEqual([1]);
    expect(advanced.spawn[0].previousReports[0].report.summary).toBe(
      UNSTARTED_STEP_REPORT_SUMMARY,
    );
  });

  it("keeps the refusal reason of a failed spawn through persistence and into its report", () => {
    const reason = "The invented native lineage refused this step";
    const failed = withWaveStepPhase(
      waveOf([step("scout", "one"), step("qa", "two", "all")]),
      0,
      { phase: "failed", failureReason: reason },
    );
    const restored = parseWaveEngineState(
      JSON.parse(JSON.stringify({ version: 2, waves: [failed] })),
    ).waves[0];
    expect(restored.steps[0].failureReason).toBe(reason);
    const advanced = advanceWave(restored, { nodes: [], reportOf: noReports });
    expect(advanced.spawn[0].previousReports[0].report.summary).toBe(
      `${UNSTARTED_STEP_REPORT_SUMMARY} The app refused it: ${reason}`,
    );
    // A later phase change that is not a failure drops the stale reason.
    expect(
      withWaveStepPhase(restored, 0, { phase: "pending" }).steps[0]
        .failureReason,
    ).toBeUndefined();
  });
});

describe("advanceWave reconciliation", () => {
  it("adopts an existing node as spawned, so a restart cannot double-spawn", () => {
    const wave = withWaveStepPhase(waveOf([step("scout", "one")]), 0, {
      phase: "spawning",
    });
    const advanced = advanceWave(wave, {
      nodes: [workerNode(0, "running")],
      reportOf: noReports,
      resumeOrphanedSpawns: true,
    });
    expect(advanced.spawn).toHaveLength(0);
    expect(advanced.changed).toBe(true);
    expect(advanced.wave.steps[0]).toMatchObject({
      phase: "spawned",
      sessionId: "child-0",
      runId: "run-0",
    });
  });
});

describe("advanceWave restart resume", () => {
  function interruptedNode(stepIndex: number): SessionNode {
    return {
      ...workerNode(stepIndex, "stopped"),
      interruptedByRestart: true,
      stopReason: "Ended by an app restart.",
    };
  }

  it("sends a step the restart ended back out once, carrying the dead session", () => {
    const wave = withWaveStepPhase(waveOf([step("scout", "one")]), 0, {
      phase: "spawned",
      sessionId: "child-0",
      runId: "run-0",
    });
    const advanced = advanceWave(wave, {
      nodes: [interruptedNode(0)],
      reportOf: noReports,
    });
    expect(advanced.changed).toBe(true);
    expect(advanced.wave.steps[0]).toMatchObject({
      phase: "pending",
      resumeCount: 1,
      resumedFromSessionId: "child-0",
    });
    expect(advanced.spawn).toHaveLength(1);
    expect(advanced.spawn[0].resume).toEqual({
      previousSessionId: "child-0",
      resumeCount: 1,
    });
    // The wave is not interrupted: its step is being resumed, not given up.
    expect(advanced.complete).toBe(false);

    // The next pass sees the dead node still in the graph and the step mid
    // spawn: the dead node must not reconcile the step back to `spawned`.
    const again = advanceWave(
      withWaveStepPhase(advanced.wave, 0, { phase: "spawning" }),
      {
        nodes: [interruptedNode(0)],
        reportOf: noReports,
        inFlight: new Set([0]),
      },
    );
    expect(again.wave.steps[0].phase).toBe("spawning");
    expect(again.spawn).toHaveLength(0);

    // The new session registers under the same step: it is the executor now.
    const resumed = advanceWave(again.wave, {
      nodes: [
        { ...interruptedNode(0), supersededBySessionId: "child-0b" },
        { ...workerNode(0, "running"), sessionId: "child-0b", runId: "run-0b" },
      ],
      reportOf: noReports,
    });
    expect(resumed.wave.steps[0]).toMatchObject({
      phase: "spawned",
      sessionId: "child-0b",
      runId: "run-0b",
      resumedFromSessionId: "child-0",
    });
  });

  it("does not resume a step whose dead session had already reported", () => {
    const wave = withWaveStepPhase(waveOf([step("scout", "one")]), 0, {
      phase: "spawned",
      sessionId: "child-0",
      runId: "run-0",
    });
    const advanced = advanceWave(wave, {
      nodes: [interruptedNode(0)],
      reportOf: (runId) =>
        runId === "run-0"
          ? report("run-0", "all done before the crash")
          : undefined,
    });
    expect(advanced.spawn).toHaveLength(0);
    expect(advanced.wave.steps[0].phase).toBe("spawned");
  });

  it("stops resuming at the cap and lets the wave be read as interrupted", () => {
    const base = withWaveStepPhase(waveOf([step("scout", "one")]), 0, {
      phase: "spawned",
      sessionId: "child-0",
      runId: "run-0",
    });
    const wave = {
      ...base,
      steps: base.steps.map((s) => ({ ...s, resumeCount: 3 })),
    };
    const advanced = advanceWave(wave, {
      nodes: [interruptedNode(0)],
      reportOf: noReports,
    });
    expect(advanced.spawn).toHaveLength(0);
    expect(
      waveInterruptedBeforeReport(advanced.wave, () => "stopped", noReports),
    ).toBe(true);
  });
});

describe("advanceWave stub degradation (5b)", () => {
  const completedReportless = () =>
    withWaveStepPhase(waveOf([step("scout", "one")]), 0, {
      phase: "spawned",
      sessionId: "child-0",
      runId: "run-0",
    });

  it("keeps a degraded step terminal across a restart whose fresh grace would wait", () => {
    const first = advanceWave(completedReportless(), {
      nodes: [workerNode(0, "completed")],
      reportOf: noReports,
      allowSyntheticReportFor: () => true,
    });
    // A new process has no deadline for this step, so its grace callback says
    // "wait" — but the step already spent its grace and was announced, and
    // waiting again would only delay the digest a second time.
    const resumed = advanceWave(first.wave, {
      nodes: [workerNode(0, "completed")],
      reportOf: noReports,
      allowSyntheticReportFor: () => false,
    });
    expect(resumed.complete).toBe(true);
    expect(resumed.degraded).toEqual([]);
  });
});

describe("advanceWave verification gate (P62)", () => {
  const spawnedPair = () =>
    withWaveStepPhase(
      withWaveStepPhase(
        waveOf([step("brigade", "build it"), step("qa", "check it", "all")]),
        0,
        {
          phase: "spawned",
          sessionId: "child-0",
          runId: "run-0",
        },
      ),
      1,
      { phase: "pending" },
    );

  const evidenceFree = (runId: string): StructuredReport => ({
    runId,
    status: "completed",
    summary: "All done, trust me",
    decisions: [],
    artifacts: [],
    risks: [],
    needsOperator: false,
    nextSuggestedTask: null,
  });

  it("judges a completed report exactly once, and quarantines a refusal", () => {
    const first = advanceWave(spawnedPair(), {
      nodes: [workerNode(0, "completed")],
      reportOf: (runId) =>
        runId === "run-0" ? evidenceFree("run-0") : undefined,
      verifyStepReport: () => ({ ok: false, detail: "no evidence" }),
    });
    expect(first.verificationFailed).toEqual([0]);
    expect(first.wave.steps[0].reportVerified).toBe(true);
    expect(first.wave.steps[0].verificationFailed).toBe(true);

    // Exactly once: re-advancing the marked wave announces nothing new.
    const second = advanceWave(first.wave, {
      nodes: [workerNode(0, "completed")],
      reportOf: (runId) =>
        runId === "run-0" ? evidenceFree("run-0") : undefined,
      verifyStepReport: () => ({ ok: false, detail: "no evidence" }),
    });
    expect(second.verificationFailed).toEqual([]);

    // The dependent access:"all" step receives the quarantine stub, never
    // the refused claims.
    const handoff = second.spawn.find((request) => request.stepIndex === 1);
    expect(handoff).toBeDefined();
    const carried = handoff?.previousReports[0]?.report;
    expect(carried?.status).toBe("failed");
    expect(carried?.summary).toContain("failed verification");
    expect(carried?.summary).not.toContain("trust me");
  });
});

describe("interrupted waves (C3)", () => {
  function spawnedTwoStep(): WaveState {
    return withWaveStepPhase(
      withWaveStepPhase(
        waveOf([step("scout", "one"), step("qa", "two", "all")]),
        0,
        { phase: "spawned", sessionId: "child-0", runId: "run-0" },
      ),
      1,
      { phase: "pending" },
    );
  }

  /** What the graph sync writes for a run that ended without a word. */
  function standIn(runId: string, flagged = true): StructuredReport {
    return {
      ...report(runId, RUN_FALLBACK_SUMMARIES.cancelled),
      status: "cancelled",
      needsOperator: true,
      ...(flagged ? { synthesized: true } : {}),
    };
  }

  it("does not count the app's stand-in report as the step reporting", () => {
    const wave = spawnedTwoStep();
    expect(
      hasAttestedWaveStepReport(wave, (runId) =>
        runId === "run-0" ? standIn("run-0") : undefined,
      ),
    ).toBe(false);
    // A stand-in persisted before the flag existed is known by its text.
    expect(hasAttestedWaveStepReport(wave, () => standIn("run-0", false))).toBe(
      false,
    );
    expect(
      hasAttestedWaveStepReport(wave, () =>
        report("run-0", "Found three callers"),
      ),
    ).toBe(true);
  });

  it("calls a wave interrupted once its killed worker is all it has", () => {
    const wave = spawnedTwoStep();
    const status = (value: RunStatus) => () => value;
    expect(
      waveInterruptedBeforeReport(wave, status("stopped"), () => undefined),
    ).toBe(true);
    expect(
      waveInterruptedBeforeReport(wave, status("cancelled"), () =>
        standIn("run-0"),
      ),
    ).toBe(true);
    // Still working, or finished by itself, is not killed…
    expect(
      waveInterruptedBeforeReport(wave, status("running"), () => undefined),
    ).toBe(false);
    expect(
      waveInterruptedBeforeReport(wave, status("completed"), () => undefined),
    ).toBe(false);
    // …and a report from any step makes it a finished wave for the digest.
    expect(
      waveInterruptedBeforeReport(wave, status("stopped"), () =>
        report("run-0", "Done"),
      ),
    ).toBe(false);
  });

  it("waits for a sibling that is still working", () => {
    const wave = withWaveStepPhase(
      withWaveStepPhase(
        waveOf([step("scout", "one"), step("scout", "two")]),
        0,
        {
          phase: "spawned",
          sessionId: "child-0",
          runId: "run-0",
        },
      ),
      1,
      { phase: "spawned", sessionId: "child-1", runId: "run-1" },
    );
    expect(
      waveInterruptedBeforeReport(
        wave,
        (stepIndex) => (stepIndex === 0 ? "stopped" : "running"),
        () => undefined,
      ),
    ).toBe(false);
    expect(
      waveInterruptedBeforeReport(
        wave,
        (stepIndex) => (stepIndex === 0 ? "stopped" : "cancelled"),
        () => undefined,
      ),
    ).toBe(true);
  });
});
