import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearAppNavigationController,
  registerAppNavigationController,
} from "@/features/flockctl/bridge/appNavigationController";
import { dispatchCommand } from "@/features/flockctl/commands/registry";
import { CommandError } from "@/features/flockctl/commands/types";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import type { SessionNode } from "@/features/conductor/types";
import { createWaveState } from "@/features/conductor/waveEngine";
import {
  resetWaveEngineStateCache,
  setWaveEngineState,
  getWaveEngineState,
  emptyWaveEngineState,
} from "@/features/conductor/waveStore";
import { i18n } from "@/shared/i18n";

const stopOrchestratorSession = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/features/conductor/orchestratorControls", () => ({
  stopOrchestratorSession,
}));
const runWaveEngineTick = vi.hoisted(() => vi.fn());
vi.mock("@/features/conductor/waveRunner", () => ({ runWaveEngineTick }));

const CONDUCTOR = "conductor-1";
const ctx = {};

function conductorNode(): SessionNode {
  return {
    sessionId: CONDUCTOR,
    projectId: "project",
    role: "conductor",
    managedBy: "ui",
    parentSessionId: null,
    rootConductorId: CONDUCTOR,
    runId: null,
    harnessId: "goose",
    displayName: "Producer",
    status: "stopped",
  };
}

function workerNode(waveId: string, stepIndex: number): SessionNode {
  return {
    sessionId: `${waveId}-child-${stepIndex}`,
    projectId: "project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: CONDUCTOR,
    rootConductorId: CONDUCTOR,
    runId: `run-${waveId}-${stepIndex}`,
    harnessId: "goose",
    displayName: `Worker ${stepIndex}`,
    status: "running",
    waveId,
    stepIndex,
    stopReason: undefined,
  };
}

function seed() {
  const running = createWaveState({
    waveId: "aaaaaaaa-0000-0000-0000-000000000001",
    conductorSessionId: CONDUCTOR,
    planMessageId: "plan-1",
    steps: [
      { role: "scout", subtask: "Find callers", access: [] },
      { role: "qa", subtask: "Check them", access: "all", label: "check" },
    ],
    createdAt: 1_000,
  });
  const live = {
    ...running,
    steps: running.steps.map((step) =>
      step.stepIndex === 0
        ? {
            ...step,
            phase: "spawned" as const,
            sessionId: `${running.waveId}-child-0`,
            runId: `run-${running.waveId}-0`,
          }
        : step,
    ),
  };
  const queued = {
    ...createWaveState({
      waveId: "bbbbbbbb-0000-0000-0000-000000000002",
      conductorSessionId: CONDUCTOR,
      planMessageId: "plan-2",
      steps: [{ role: "scout", subtask: "Map assets", access: [] }],
      createdAt: 2_000,
    }),
    phase: "queued" as const,
  };
  setWaveEngineState({
    ...emptyWaveEngineState(),
    waves: [live, queued],
    roadmaps: {
      [CONDUCTOR]: {
        conductorSessionId: CONDUCTOR,
        goal: "Make the game playable",
        status: "in-progress",
        stages: [{ title: "Callers", status: "active", evidence: [] }],
        updatedAt: 3_000,
        sourceMessageId: "plan-1",
        sourceCreatedAt: 1_000,
        continueTurns: 0,
      },
    },
  });
  const graph = useConductorGraphStore.getState();
  graph.registerNode(conductorNode());
  graph.registerNode(workerNode(live.waveId, 0));
  graph.attachReport({
    runId: `run-${live.waveId}-0`,
    status: "completed",
    summary: "Found twelve callers",
    decisions: [],
    artifacts: [],
    risks: [],
    needsOperator: false,
    nextSuggestedTask: null,
  });
  return { live, queued };
}

async function expectCommandError(
  promise: Promise<unknown>,
  code: string,
): Promise<CommandError> {
  const error = await promise.then(
    () => {
      throw new Error("expected the command to fail");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(CommandError);
  expect((error as CommandError).code).toBe(code);
  return error as CommandError;
}

describe("wave commands", () => {
  beforeEach(async () => {
    await i18n.loadNamespaces("chat");
    window.localStorage.clear();
    resetWaveEngineStateCache();
    stopOrchestratorSession.mockClear();
    runWaveEngineTick.mockClear();
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    useChatStore.setState({ messagesBySession: {} });
    useChatSessionStore.setState({ hasHydratedSessions: true, sessions: [] });
    registerAppNavigationController({
      openSession: vi.fn(async () => ({ ok: true })),
      archiveSession: vi.fn(async () => ({ ok: true })),
      getAppContext: vi.fn(() => ({
        view: "home",
        activeSessionId: "viewed",
        activeProjectId: null,
      })),
    } as never);
  });

  afterEach(() => {
    clearAppNavigationController();
    resetWaveEngineStateCache();
  });

  it("lists live and queued waves with each step's session, and parked ones on request", async () => {
    const { live, queued } = seed();
    const result = (await dispatchCommand(
      "waves",
      { action: "list", conductor_session_id: CONDUCTOR },
      ctx,
    )) as { waves: Array<Record<string, unknown>> };
    expect(result.waves.map((wave) => wave.wave_id)).toEqual([
      queued.waveId,
      live.waveId,
    ]);
    expect(result.waves[0]).toMatchObject({
      phase: "queued",
      live: false,
      queued_position: 1,
    });
    const steps = result.waves[1].steps as Array<Record<string, unknown>>;
    expect(steps[0]).toMatchObject({
      step: 1,
      role: "scout",
      session_id: `${live.waveId}-child-0`,
      status: "running",
      report: { status: "completed", summary: "Found twelve callers" },
      subtask: null,
    });
    expect(steps[1]).toMatchObject({
      step: 2,
      label: "check",
      access: "all",
      phase: "pending",
      session_id: null,
    });
  });

  it("reads one wave by an id prefix, with briefs and the conductor's roadmap", async () => {
    const { live } = seed();
    const result = (await dispatchCommand(
      "waves",
      { action: "get", wave_id: "aaaaaaaa" },
      ctx,
    )) as {
      wave: { wave_id: string; steps: Array<{ subtask: string }> };
      roadmap: { goal: string };
    };
    expect(result.wave.wave_id).toBe(live.waveId);
    expect(result.wave.steps[1].subtask).toBe("Check them");
    expect(result.roadmap.goal).toBe("Make the game playable");
    await expectCommandError(
      dispatchCommand("waves", { action: "get", wave_id: "zzzz" }, ctx),
      "wave_not_found",
    );
  });

  it("cancels a live wave by stopping its executors, and drops a queued one", async () => {
    const { live, queued } = seed();
    const stopped = (await dispatchCommand(
      "waves",
      { action: "cancel", wave_id: live.waveId },
      ctx,
    )) as { outcome: string };
    expect(stopped.outcome).toBe("stopped");
    expect(stopOrchestratorSession).toHaveBeenCalledWith(
      `${live.waveId}-child-0`,
      expect.stringContaining("cancelled"),
    );
    expect(
      getWaveEngineState().waves.find((wave) => wave.waveId === live.waveId)
        ?.phase,
    ).toBe("needsOperator");

    const dropped = (await dispatchCommand(
      "waves",
      { action: "cancel", wave_id: queued.waveId },
      ctx,
    )) as { outcome: string };
    expect(dropped.outcome).toBe("dropped");
    expect(
      getWaveEngineState().waves.some((wave) => wave.waveId === queued.waveId),
    ).toBe(false);

    const again = (await dispatchCommand(
      "waves",
      { action: "cancel", wave_id: live.waveId },
      ctx,
    )) as { outcome: string };
    expect(again.outcome).toBe("already_closed");
  });

  it("extends a pending step's brief and refuses a dispatched one", async () => {
    const { live } = seed();
    await dispatchCommand(
      "waves",
      {
        action: "amend",
        wave_id: live.waveId,
        step: 2,
        text: "Also check the lock.",
      },
      ctx,
    );
    expect(
      getWaveEngineState().waves.find((wave) => wave.waveId === live.waveId)
        ?.steps[1].subtask,
    ).toBe("Check them\n\nAlso check the lock.");
    await expectCommandError(
      dispatchCommand(
        "waves",
        { action: "amend", wave_id: live.waveId, step: 1, text: "too late" },
        ctx,
      ),
      "wave_step_not_pending",
    );
    const notices = (useChatStore.getState().messagesBySession[CONDUCTOR] ?? [])
      .flatMap((message) => message.content)
      .filter((block) => block.type === "systemNotification");
    expect(notices).toHaveLength(1);
  });

  it("runs a dispatched step again in a new session, with a correction", async () => {
    const { live } = seed();
    const child = `${live.waveId}-child-0`;
    useConductorGraphStore.setState({
      nodesById: {
        [CONDUCTOR]: conductorNode(),
        [child]: workerNode(live.waveId, 0),
      },
    });
    const result = await dispatchCommand(
      "waves",
      {
        action: "restart",
        wave_id: live.waveId,
        step: 1,
        text: "Use the 2020 register.",
      },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      step: 1,
      stopped_session_id: child,
    });
    // The session at work on the step is stopped, and says why.
    expect(stopOrchestratorSession).toHaveBeenCalledWith(
      child,
      expect.stringContaining("run again"),
    );
    const step = getWaveEngineState().waves.find(
      (wave) => wave.waveId === live.waveId,
    )?.steps[0];
    // The step waits to be dispatched afresh: no session, no run, and the
    // one it is taken from is never read as its executor again.
    expect(step).toMatchObject({
      phase: "pending",
      resumedFromSessionId: child,
    });
    expect(step?.sessionId).toBeUndefined();
    expect(step?.runId).toBeUndefined();
    expect(step?.subtask).toContain("Find callers");
    expect(step?.subtask).toContain("started again on the operator's order");
    expect(step?.subtask.endsWith("Use the 2020 register.")).toBe(true);
    expect(runWaveEngineTick).toHaveBeenCalled();
    const notices = (useChatStore.getState().messagesBySession[CONDUCTOR] ?? [])
      .flatMap((message) => message.content)
      .filter((block) => block.type === "systemNotification");
    expect(notices).toHaveLength(1);

    // A step that has not started is amended, not restarted.
    await expectCommandError(
      dispatchCommand(
        "waves",
        { action: "restart", wave_id: live.waveId, step: 2 },
        ctx,
      ),
      "wave_step_not_dispatched",
    );
  });

  it("refuses to run again a step of a wave that is past its steps", async () => {
    const { live } = seed();
    setWaveEngineState({
      ...getWaveEngineState(),
      waves: getWaveEngineState().waves.map((wave) =>
        wave.waveId === live.waveId
          ? { ...wave, phase: "awaitingVerdict" as const }
          : wave,
      ),
    });
    await expectCommandError(
      dispatchCommand(
        "waves",
        { action: "restart", wave_id: live.waveId, step: 1 },
        ctx,
      ),
      "wave_not_running",
    );
    expect(stopOrchestratorSession).not.toHaveBeenCalled();
  });

  it("checks a plan without running it, and says why one would be refused", async () => {
    const before = getWaveEngineState();
    const good = await dispatchCommand(
      "waves",
      {
        action: "validate",
        plan: JSON.stringify({
          parallel: 2,
          steps: [
            {
              role: "scout",
              subtask: "Read your slice",
              access: [],
              label: "read",
              shards: ["g01", "g02", "g03"],
            },
            { role: "qa", subtask: "Check the notes", access: "all" },
          ],
        }),
      },
      ctx,
    );
    expect(good).toMatchObject({ ok: true, executors: 4, parallel: 2 });
    expect((good as { steps: unknown[] }).steps).toEqual([
      {
        step: 1,
        role: "scout",
        label: "read 1/3",
        access: "none",
        model: null,
      },
      {
        step: 2,
        role: "scout",
        label: "read 2/3",
        access: "none",
        model: null,
      },
      {
        step: 3,
        role: "scout",
        label: "read 3/3",
        access: "none",
        model: null,
      },
      { step: 4, role: "qa", label: null, access: "all", model: null },
    ]);

    // The whole message a conductor would send is read the same way.
    const fenced = await dispatchCommand(
      "waves",
      {
        action: "validate",
        plan: 'Here is the plan.\n\n```distill-wave\n{"steps":[{"role":"scout","subtask":"Look","access":[]}]}\n```',
      },
      ctx,
    );
    expect(fenced).toMatchObject({ ok: true, executors: 1, parallel: 8 });

    const broken = await dispatchCommand(
      "waves",
      {
        action: "validate",
        plan: '{"steps":[{"role":"scout","subtask":"Look","access":[],"shards":["only one"]}]}',
      },
      ctx,
    );
    expect(broken).toMatchObject({
      ok: false,
      reason: "shards-invalid",
      step: 1,
    });
    expect(
      await dispatchCommand(
        "waves",
        { action: "validate", plan: '{"steps":[' },
        ctx,
      ),
    ).toMatchObject({ ok: false, reason: "malformed-json", step: null });
    // Nothing was admitted, started or recorded.
    expect(getWaveEngineState()).toEqual(before);
    expect(runWaveEngineTick).not.toHaveBeenCalled();
  });

  it("skips a pending step so its dependents proceed", async () => {
    const { live } = seed();
    await dispatchCommand(
      "waves",
      { action: "skip", wave_id: live.waveId, step: 2 },
      ctx,
    );
    expect(
      getWaveEngineState().waves.find((wave) => wave.waveId === live.waveId)
        ?.steps[1],
    ).toMatchObject({
      phase: "failed",
      failureReason: expect.stringContaining("Skipped"),
    });
    expect(runWaveEngineTick).toHaveBeenCalled();
  });

  it("writes down an agent's command as the agent's, never as the operator's order", async () => {
    const notices = () =>
      (useChatStore.getState().messagesBySession[CONDUCTOR] ?? []).flatMap(
        (message) =>
          message.content.flatMap((block) =>
            block.type === "systemNotification" ? [block.text] : [],
          ),
      );
    const fromAgent = { fromAgent: true };
    const { live } = seed();
    useChatStore.setState({ messagesBySession: {} });

    await dispatchCommand(
      "waves",
      { action: "skip", wave_id: live.waveId, step: 2 },
      fromAgent,
    );
    expect(
      getWaveEngineState().waves.find((wave) => wave.waveId === live.waveId)
        ?.steps[1].failureReason,
    ).toBe("Skipped at an agent's request through flockctl.");
    expect(notices().join("\n")).toContain("at an agent's request");
    expect(notices().join("\n")).not.toContain("operator's order");

    useChatStore.setState({ messagesBySession: {} });
    await dispatchCommand(
      "waves",
      { action: "cancel", wave_id: live.waveId },
      // A harness that exports its own actor is an agent just the same.
      { actor: `${live.waveId}-child-0` },
    );
    expect(stopOrchestratorSession).toHaveBeenCalledWith(
      `${live.waveId}-child-0`,
      "Stopped at an agent's request through flockctl: the wave was cancelled.",
    );
    expect(notices().join("\n")).toContain("An agent stopped this wave");
    expect(notices().join("\n")).not.toContain("You stopped this wave");
  });

  it("keeps the operator's own command in the operator's name", async () => {
    const { live } = seed();
    useChatStore.setState({ messagesBySession: {} });
    await dispatchCommand(
      "waves",
      { action: "skip", wave_id: live.waveId, step: 2 },
      ctx,
    );
    await dispatchCommand(
      "waves",
      { action: "cancel", wave_id: live.waveId },
      ctx,
    );
    const said = (useChatStore.getState().messagesBySession[CONDUCTOR] ?? [])
      .flatMap((message) =>
        message.content.flatMap((block) =>
          block.type === "systemNotification" ? [block.text] : [],
        ),
      )
      .join("\n");
    expect(said).toContain("operator's order");
    expect(said).toContain("You stopped this wave");
    expect(said).not.toContain("agent");
  });

  it("reads the roadmap, or null for a conductor without one", async () => {
    seed();
    const result = (await dispatchCommand(
      "waves",
      { action: "roadmap", conductor_session_id: CONDUCTOR },
      ctx,
    )) as { roadmap: { stages: Array<{ title: string }> } };
    expect(result.roadmap.stages[0].title).toBe("Callers");
    const none = (await dispatchCommand(
      "waves",
      { action: "roadmap", conductor_session_id: "other" },
      ctx,
    )) as { roadmap: null };
    expect(none.roadmap).toBeNull();
  });

  it("describes the caller's own session in info context when it names one", async () => {
    const { live } = seed();
    const result = (await dispatchCommand(
      "info",
      { action: "get_context", session_id: `${live.waveId}-child-0` },
      ctx,
    )) as { active_session_id: string; session: Record<string, unknown> };
    expect(result.active_session_id).toBe("viewed");
    expect(result.session).toMatchObject({
      session_id: `${live.waveId}-child-0`,
      parent_session_id: CONDUCTOR,
      wave_id: live.waveId,
      wave_step: 1,
      role: "worker",
    });
    const viewed = (await dispatchCommand(
      "info",
      { action: "get_context" },
      ctx,
    )) as { session: null };
    expect(viewed.session).toBeNull();
  });
});
