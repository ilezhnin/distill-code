import { describe, expect, it } from "vitest";

import { parseDistillWave, type WaveStep } from "./distillWave";
import type { RunStatus, SessionNode, StructuredReport } from "./types";
import {
  MISSING_STEP_REPORT_SUMMARY,
  UNSTARTED_STEP_REPORT_SUMMARY,
  admitWavePlan,
  advanceWave,
  collectWaveStepReports,
  createWaveState,
  isTerminalRunStatus,
  reportStatusForTerminalRun,
  withWavePhase,
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
  it("accepts a parsed plan", () => {
    const parse = parseDistillWave(
      'Here you go.\n\n```distill-wave\n{"steps":[{"role":"scout","subtask":"Find the callers","access":[]}]}\n```',
    );
    const admission = admitWavePlan(parse);
    expect(admission.kind).toBe("accepted");
    if (admission.kind !== "accepted") return;
    expect(admission.steps).toHaveLength(1);
    expect(admission.steps[0].role).toBe("scout");
  });

  it("forwards the parser's enumerated reason", () => {
    const parse = parseDistillWave("```distill-wave\nnot json\n```");
    const admission = admitWavePlan(parse);
    expect(admission).toMatchObject({
      kind: "rejected",
      reason: "malformed-json",
    });
  });

  it("keeps the offending step index of a per-step reason", () => {
    const parse = parseDistillWave(
      '```distill-wave\n{"steps":[{"role":"scout","subtask":"a","access":[]},{"role":"scout","subtask":"b","access":[1]}]}\n```',
    );
    const admission = admitWavePlan(parse);
    expect(admission).toMatchObject({
      kind: "rejected",
      reason: "access-invalid",
      stepIndex: 1,
    });
  });

  it("refuses the whole plan when any step names a model (D5 gap-guard)", () => {
    const admission = admitWavePlan({
      kind: "plan",
      planText: "",
      prose: "",
      steps: [
        step("scout", "Find the callers"),
        step("qa", "Write the test plan", [], "gpt-5"),
      ],
    });
    expect(admission).toMatchObject({
      kind: "rejected",
      reason: "step-model-unsupported",
      stepIndex: 1,
    });
    if (admission.kind !== "rejected") return;
    expect(admission.detail).toContain("gpt-5");
  });
});

describe("run status helpers", () => {
  it("treats stopped as terminal and reports it as failed", () => {
    expect(isTerminalRunStatus("stopped")).toBe(true);
    expect(isTerminalRunStatus("waiting")).toBe(false);
    expect(reportStatusForTerminalRun("stopped")).toBe("failed");
    expect(reportStatusForTerminalRun("cancelled")).toBe("cancelled");
    expect(reportStatusForTerminalRun("completed")).toBe("completed");
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

  it("does not let a failed earlier step block an access:all step", () => {
    const wave = withWaveStepPhase(
      waveOf([step("scout", "one"), step("qa", "two", "all")]),
      0,
      { phase: "spawned", sessionId: "child-0", runId: "run-0" },
    );
    const failureReport: StructuredReport = {
      ...report("run-0", "Could not reach the API"),
      status: "failed",
      needsOperator: true,
    };
    const advanced = advanceWave(wave, {
      nodes: [workerNode(0, "failed")],
      reportOf: () => failureReport,
    });
    expect(advanced.spawn.map((request) => request.stepIndex)).toEqual([1]);
    expect(advanced.spawn[0].previousReports[0].report).toBe(failureReport);
  });

  it("synthesizes a report for a terminal step that produced none", () => {
    const wave = withWaveStepPhase(
      waveOf([step("scout", "one"), step("qa", "two", "all")]),
      0,
      { phase: "spawned", sessionId: "child-0", runId: "run-0" },
    );
    const advanced = advanceWave(wave, {
      nodes: [workerNode(0, "stopped")],
      reportOf: noReports,
    });
    expect(advanced.spawn.map((request) => request.stepIndex)).toEqual([1]);
    expect(advanced.spawn[0].previousReports[0].report).toMatchObject({
      status: "failed",
      summary: MISSING_STEP_REPORT_SUMMARY,
      needsOperator: true,
    });
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

  it("never re-requests a step whose spawn is in flight", () => {
    const wave = waveOf([step("scout", "one"), step("qa", "two")]);
    const advanced = advanceWave(wave, {
      nodes: [],
      reportOf: noReports,
      inFlight: new Set([0]),
    });
    expect(advanced.spawn.map((request) => request.stepIndex)).toEqual([1]);
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

  it("resumes a spawn that died before its node existed", () => {
    const wave = withWaveStepPhase(waveOf([step("scout", "one")]), 0, {
      phase: "spawning",
    });
    const advanced = advanceWave(wave, {
      nodes: [],
      reportOf: noReports,
      resumeOrphanedSpawns: true,
    });
    expect(advanced.spawn.map((request) => request.stepIndex)).toEqual([0]);
    expect(advanced.wave.steps[0].phase).toBe("pending");
  });

  it("leaves a spawning step alone mid-session", () => {
    const wave = withWaveStepPhase(waveOf([step("scout", "one")]), 0, {
      phase: "spawning",
    });
    const advanced = advanceWave(wave, { nodes: [], reportOf: noReports });
    expect(advanced.spawn).toHaveLength(0);
    expect(advanced.changed).toBe(false);
    expect(advanced.wave).toBe(wave);
  });

  it("ignores nodes from another wave", () => {
    const wave = waveOf([step("scout", "one")]);
    const foreign: SessionNode = {
      ...workerNode(0, "running"),
      waveId: "wave-2",
    };
    const advanced = advanceWave(wave, {
      nodes: [foreign],
      reportOf: noReports,
    });
    expect(advanced.spawn.map((request) => request.stepIndex)).toEqual([0]);
  });

  it("reports the wave complete once every step is terminal", () => {
    const wave = withWaveStepPhase(
      withWaveStepPhase(waveOf([step("scout", "one"), step("qa", "two")]), 0, {
        phase: "spawned",
        sessionId: "child-0",
        runId: "run-0",
      }),
      1,
      { phase: "spawned", sessionId: "child-1", runId: "run-1" },
    );
    const advanced = advanceWave(wave, {
      nodes: [workerNode(0, "completed"), workerNode(1, "failed")],
      reportOf: noReports,
    });
    expect(advanced.complete).toBe(true);
    expect(advanced.spawn).toHaveLength(0);
  });
});

describe("the closed-loop fields on a wave", () => {
  it("starts a first wave running, at its own root, with no revisions spent", () => {
    const wave = waveOf([step("scout", "Look")]);
    expect(wave.phase).toBe("running");
    expect(wave.rootRequestId).toBe("plan-1");
    expect(wave.revisionCount).toBe(0);
    expect(wave.digestAttempt).toBe(0);
    expect(wave.carriedReports).toBeUndefined();
  });

  it("carries the root identity and the spent count into a revision", () => {
    const revision = createWaveState({
      waveId: "wave-2",
      conductorSessionId: "conductor-1",
      planMessageId: "verdict-1",
      steps: [step("qa", "Re-check", "all")],
      createdAt: 2,
      rootRequestId: "plan-1",
      revisionCount: 1,
      carriedReports: [
        {
          stepIndex: 0,
          role: "scout",
          subtask: "Look",
          fromPreviousWave: true,
          report: report("run-prev", "Found three"),
        },
      ],
    });
    expect(revision.rootRequestId).toBe("plan-1");
    expect(revision.revisionCount).toBe(1);
    expect(revision.carriedReports).toHaveLength(1);
  });

  it("hands a revision's first `all` step the previous wave's reports", () => {
    const revision = createWaveState({
      waveId: "wave-2",
      conductorSessionId: "conductor-1",
      planMessageId: "verdict-1",
      steps: [step("qa", "Re-check", "all")],
      createdAt: 2,
      rootRequestId: "plan-1",
      revisionCount: 1,
      carriedReports: [
        {
          stepIndex: 0,
          role: "scout",
          subtask: "Look",
          report: report("run-prev", "Found three"),
        },
      ],
    });
    // Without this, the revision's very first step has no earlier step of its
    // own to inherit from and would start blind.
    const advanced = advanceWave(revision, {
      nodes: [],
      reportOf: () => undefined,
    });
    expect(advanced.spawn).toHaveLength(1);
    const [request] = advanced.spawn;
    expect(request.previousReports).toHaveLength(1);
    expect(request.previousReports[0].fromPreviousWave).toBe(true);
    expect(request.previousReports[0].report.summary).toBe("Found three");
  });

  it("moves a wave between phases without touching its steps", () => {
    const wave = waveOf([step("scout", "Look")]);
    const parked = withWavePhase(wave, "needsOperator");
    expect(parked.phase).toBe("needsOperator");
    expect(parked.steps).toBe(wave.steps);
    expect(withWavePhase(parked, "needsOperator")).toBe(parked);
  });
});

describe("collectWaveStepReports", () => {
  it("returns one entry per step, in step order", () => {
    let wave = waveOf([step("scout", "Look"), step("qa", "Check", "all")]);
    wave = withWaveStepPhase(wave, 0, {
      phase: "spawned",
      sessionId: "child-0",
      runId: "run-0",
    });
    wave = withWaveStepPhase(wave, 1, {
      phase: "spawned",
      sessionId: "child-1",
      runId: "run-1",
    });
    const reports = collectWaveStepReports(wave, (runId) =>
      runId === "run-0" ? report("run-0", "Found three") : undefined,
    );
    expect(reports.map((entry) => entry.stepIndex)).toEqual([0, 1]);
    expect(reports[0].report.summary).toBe("Found three");
    // A step that finished without a report is never silently dropped from the
    // digest — it contributes a stand-in that says so.
    expect(reports[1].report.summary).toBe(MISSING_STEP_REPORT_SUMMARY);
    expect(reports[1].report.needsOperator).toBe(true);
  });

  it("says so when a step was never started at all", () => {
    const wave = withWaveStepPhase(waveOf([step("scout", "Look")]), 0, {
      phase: "failed",
    });
    const [entry] = collectWaveStepReports(wave, () => undefined);
    expect(entry.report.summary).toBe(UNSTARTED_STEP_REPORT_SUMMARY);
    expect(entry.report.status).toBe("failed");
  });
});
