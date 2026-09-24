import { describe, expect, it } from "vitest";

import { i18n } from "@/shared/i18n";

import type { WaveStep } from "./distillWave";
import { waveRejectionNoticeText } from "./waveNotices";
import type { RunStatus, SessionNode, StructuredReport } from "./types";
import {
  UNSTARTED_STEP_REPORT_SUMMARY,
  admitWavePlan,
  advanceWave,
  createWaveState,
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
