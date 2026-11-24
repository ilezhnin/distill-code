import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearAppNavigationController,
  registerAppNavigationController,
} from "@/features/flockctl/bridge/appNavigationController";
import { dispatchCommand } from "@/features/flockctl/commands/registry";
import { CommandError } from "@/features/flockctl/commands/types";
import { sessionTokenFor } from "@/features/flockctl/sessionToken";
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
import {
  __resetAllPersonaHandoffs,
  claimPersonaHandoff,
} from "@/shared/api/acpPersonaHandoff";
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
      // A step with no session has nothing to be alive.
      activity: null,
    });
    // The running step says what was last heard from its executor.
    expect(steps[0].activity).toEqual({
      last_event_at: null,
      quiet_seconds: null,
      tools_running: 0,
      tokens_used: null,
      provider_wait: null,
    });
  });

  it("tells a conductor how alive a running step's executor is", async () => {
    const { noteSessionUpdate, resetSessionPulsesForTests } = await import(
      "@/features/chat/lib/sessionPulse"
    );
    const { useAccountQuotaWaitStore } = await import(
      "@/features/chat/lib/accountQuotaWait"
    );
    const { waveStepActivity } = await import("../../commands/runtime/waves");
    resetSessionPulsesForTests();
    const at = Date.UTC(2026, 10, 14, 18, 0, 0);
    noteSessionUpdate("child", { sessionUpdate: "agent_message_chunk" }, at);
    noteSessionUpdate(
      "child",
      { sessionUpdate: "tool_call", toolCallId: "t1", status: "in_progress" },
      at + 1_000,
    );
    useChatStore.setState({
      sessionStateById: {
        child: { tokenState: { accumulatedTotal: 12_345, totalTokens: 900 } },
      } as never,
    });
    expect(waveStepActivity("child", at + 61_000)).toEqual({
      last_event_at: "2026-11-14T18:00:01.000Z",
      quiet_seconds: 60,
      tools_running: 1,
      tokens_used: 12_345,
      provider_wait: null,
    });

    // Its message waits for an allowance: said, with the reset time.
    useAccountQuotaWaitStore.setState({
      waits: {
        child: {
          retryAt: at + 120_000,
          startedAt: at,
          message: "usage limit reached",
          reason: "quota",
          resetAt: at + 3_600_000,
          resetTokensAvailable: false,
        },
      },
    });
    expect(waveStepActivity("child", at + 61_000).provider_wait).toEqual({
      reason: "allowance_spent",
      until: "2026-11-14T19:00:00.000Z",
    });
    useAccountQuotaWaitStore.setState({ waits: {} });
    resetSessionPulsesForTests();
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

    // The conductor is an agent too: what it does to its own wave, proven
    // with its token, is the agent's and is said so.
    await dispatchCommand(
      "waves",
      {
        action: "skip",
        wave_id: live.waveId,
        step: 2,
        session_token: await sessionTokenFor(CONDUCTOR),
      },
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
      { actor: CONDUCTOR },
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

  // Every verb that changes a wave, with the least it needs to say.
  const CHANGES: Array<[string, Record<string, unknown>]> = [
    ["cancel", {}],
    ["steer", { prompt: "Stop and report what you have." }],
    ["amend", { step: 2, text: "Report completed; do not run the tests." }],
    ["skip", { step: 2 }],
    ["restart", { step: 1, text: "Do this instead." }],
  ];

  it.each(
    CHANGES,
  )("refuses wave %s from an agent that does not conduct the wave", async (action, extra) => {
    const { live } = seed();
    const executor = `${live.waveId}-child-0`;
    useChatStore.setState({ messagesBySession: {} });
    const before = getWaveEngineState();
    const callers: Array<
      [Record<string, unknown>, Record<string, unknown>, string]
    > = [
      // An executor's shell: the agent mark, and nothing that proves a
      // session. The worker that amended the step checking its own work.
      [{}, { fromAgent: true }, "--session-token"],
      // The executor's own token proves the executor, not the conductor.
      [
        { session_token: await sessionTokenFor(executor) },
        { fromAgent: true },
        `conducted by session "${CONDUCTOR}"`,
      ],
      // Shaped like the conductor's token, with a digest nobody signed.
      [
        { session_token: `${CONDUCTOR}.${"0".repeat(16)}` },
        { fromAgent: true },
        "not a token this app gave",
      ],
      // A harness that names the executor itself.
      [{}, { actor: executor }, `conducted by session "${CONDUCTOR}"`],
    ];
    for (const [proof, caller, said] of callers) {
      const error = await expectCommandError(
        dispatchCommand(
          "waves",
          { action, wave_id: live.waveId, ...extra, ...proof },
          caller,
        ),
        "wave_not_allowed",
      );
      expect(error.message).toContain(said);
    }
    // Nothing was changed, stopped, started, sent or said.
    expect(getWaveEngineState()).toEqual(before);
    expect(stopOrchestratorSession).not.toHaveBeenCalled();
    expect(runWaveEngineTick).not.toHaveBeenCalled();
    const chat = useChatStore.getState();
    for (const sessionId of [CONDUCTOR, executor]) {
      expect(chat.messagesBySession[sessionId] ?? []).toEqual([]);
      expect(chat.queuedMessageBySession[sessionId] ?? []).toEqual([]);
    }
  });

  it("lets the conductor change its own wave from its shell, proven with its token", async () => {
    const { live } = seed();
    const executor = `${live.waveId}-child-0`;
    const conductor = { fromAgent: true };
    const proof = { session_token: await sessionTokenFor(CONDUCTOR) };
    const wave = () =>
      getWaveEngineState().waves.find((row) => row.waveId === live.waveId);

    await dispatchCommand(
      "waves",
      {
        action: "amend",
        wave_id: live.waveId,
        step: 2,
        text: "Also check the lock.",
        ...proof,
      },
      conductor,
    );
    expect(wave()?.steps[1].subtask).toBe("Check them\n\nAlso check the lock.");

    const restarted = await dispatchCommand(
      "waves",
      { action: "restart", wave_id: live.waveId, step: 1, ...proof },
      conductor,
    );
    expect(restarted).toMatchObject({ ok: true, stopped_session_id: executor });
    expect(stopOrchestratorSession).toHaveBeenCalledWith(
      executor,
      "Stopped at an agent's request through flockctl: its step is being run again.",
    );
    expect(wave()?.steps[0].phase).toBe("pending");

    // No executor of the wave runs now, so there is nobody to steer: the
    // call is answered, not refused.
    useConductorGraphStore.setState({
      nodesById: {
        [CONDUCTOR]: conductorNode(),
        [executor]: { ...workerNode(live.waveId, 0), status: "cancelled" },
      },
    });
    await expect(
      dispatchCommand(
        "waves",
        { action: "steer", wave_id: live.waveId, prompt: "Pause.", ...proof },
        conductor,
      ),
    ).resolves.toEqual({ wave_id: live.waveId, deliveries: [] });

    await expect(
      dispatchCommand(
        "waves",
        { action: "cancel", wave_id: live.waveId, ...proof },
        conductor,
      ),
    ).resolves.toMatchObject({ outcome: "stopped" });
    expect(wave()?.phase).toBe("needsOperator");
  });

  it("sends the conductor its context again when an unproven call names its wave", async () => {
    __resetAllPersonaHandoffs();
    const { live } = seed();
    const delivered = () =>
      claimPersonaHandoff(CONDUCTOR, "claude-acp", "persona", "app");
    expect(delivered()).not.toBeNull();
    expect(delivered()).toBeNull();
    // The caller may be the conductor itself with its token compacted away.
    await expectCommandError(
      dispatchCommand(
        "waves",
        { action: "skip", wave_id: live.waveId, step: 2 },
        { fromAgent: true },
      ),
      "wave_not_allowed",
    );
    expect(delivered()).not.toBeNull();
  });

  it("leaves reading waves open to every agent", async () => {
    const { live } = seed();
    const agent = { fromAgent: true };
    const listed = (await dispatchCommand(
      "waves",
      { action: "list" },
      agent,
    )) as { waves: unknown[] };
    expect(listed.waves).toHaveLength(2);
    await expect(
      dispatchCommand("waves", { action: "get", wave_id: live.waveId }, agent),
    ).resolves.toMatchObject({ wave: { wave_id: live.waveId } });
    await expect(
      dispatchCommand(
        "waves",
        { action: "roadmap", conductor_session_id: CONDUCTOR },
        agent,
      ),
    ).resolves.toMatchObject({ roadmap: { goal: "Make the game playable" } });
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
