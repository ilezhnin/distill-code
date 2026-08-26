import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { i18n } from "@/shared/i18n";
import type { Message } from "@/shared/types/messages";

import { useConductorGraphStore } from "./conductorGraphStore";
import type { SessionNode } from "./types";
import {
  resetWaveStepTargetIoForTests,
  setWaveStepTargetIoForTests,
} from "./waveStepTarget";

const spawnConductorChildSession = vi.hoisted(() => vi.fn());

vi.mock("./spawnOrchestrator", () => ({ spawnConductorChildSession }));

const stopOrchestratorSession = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./orchestratorControls", () => ({ stopOrchestratorSession }));

const {
  WAVE_REPORT_GRACE_MS,
  WAVE_SPAWN_TIMEOUT_MS,
  resetWaveRunnerForTests,
  runWaveEngineTick,
} = await import("./waveRunner");
const {
  CONDUCTOR_WAVES_STORAGE_KEY,
  getWaveEngineState,
  hasWaveTombstone,
  resetWaveEngineStateCache,
  setWaveEngineState,
  withWave,
} = await import("./waveStore");
const { stopWaveByOperator } = await import("./waveStop");
const { getWaveTelemetry } = await import("./waveTelemetryStore");

const CONDUCTOR_ID = "conductor-1";

function conductorNode(): SessionNode {
  return {
    sessionId: CONDUCTOR_ID,
    projectId: "project",
    role: "conductor",
    managedBy: "ui",
    parentSessionId: null,
    rootConductorId: CONDUCTOR_ID,
    runId: null,
    harnessId: "goose",
    displayName: "Producer",
    status: "stopped",
  };
}

function assistant(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [{ type: "text", text }],
    metadata: { completionStatus: "completed" },
  };
}

function fence(body: string): string {
  return `Here is the plan.\n\n\`\`\`distill-wave\n${body}\n\`\`\``;
}

const TWO_STEP_PLAN = fence(
  '{"steps":[{"role":"scout","subtask":"Find every caller","access":[]},{"role":"qa","subtask":"Write the test plan","access":"all"}]}',
);

function setTranscript(messages: readonly Message[]): void {
  useChatStore.setState({
    messagesBySession: { [CONDUCTOR_ID]: [...messages] },
  });
}

function conductorMessages(): Message[] {
  return useChatStore.getState().messagesBySession[CONDUCTOR_ID] ?? [];
}

function noticeTexts(): string[] {
  return conductorMessages().flatMap((message) =>
    message.content.flatMap((block) =>
      block.type === "systemNotification" ? [block.text] : [],
    ),
  );
}

function registerSpawnedChild(args: {
  sessionId: string;
  waveId: string;
  stepIndex: number;
  runId: string;
  status?: SessionNode["status"];
}): void {
  useConductorGraphStore.getState().registerNode({
    sessionId: args.sessionId,
    projectId: "project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: CONDUCTOR_ID,
    rootConductorId: CONDUCTOR_ID,
    runId: args.runId,
    harnessId: "goose",
    displayName: args.sessionId,
    status: args.status ?? "running",
    waveId: args.waveId,
    stepIndex: args.stepIndex,
  });
}

describe("waveRunner", () => {
  beforeEach(async () => {
    await i18n.loadNamespaces("chat");
    window.localStorage.clear();
    resetWaveEngineStateCache();
    resetWaveRunnerForTests();
    spawnConductorChildSession.mockReset();
    let counter = 0;
    spawnConductorChildSession.mockImplementation(async (args) => {
      counter += 1;
      const sessionId = `child-${args.stepIndex}`;
      const runId = `run-${counter}`;
      registerSpawnedChild({
        sessionId,
        waveId: args.waveId,
        stepIndex: args.stepIndex,
        runId,
      });
      return { sessionId, runId };
    });
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    useChatStore.setState({ messagesBySession: {} });
    useChatSessionStore.setState({ hasHydratedSessions: true });
  });

  afterEach(() => {
    resetWaveRunnerForTests();
    resetWaveEngineStateCache();
  });

  it("does nothing before the session store has hydrated", () => {
    useChatSessionStore.setState({ hasHydratedSessions: false });
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    runWaveEngineTick();
    expect(spawnConductorChildSession).not.toHaveBeenCalled();
  });

  it("spawns the access:[] step immediately and holds the access:all step", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);

    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );

    const [args] = spawnConductorChildSession.mock.calls[0];
    expect(args).toMatchObject({
      parentSessionId: CONDUCTOR_ID,
      role: "worker",
      managedBy: "wave",
      stepIndex: 0,
      anchorMessageId: "plan-1",
      roleId: "scout",
      task: "Find every caller",
    });
    expect(args.waveId).toBeTruthy();
    expect(args.prompt).toContain("Find every caller");

    const state = getWaveEngineState();
    expect(state.waves).toHaveLength(1);
    expect(hasWaveTombstone(state, "plan-1")).toBe(true);
  });

  it("starts the access:all step with the earlier report once step 0 is terminal", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );

    const graph = useConductorGraphStore.getState();
    graph.patchNode("child-0", { status: "completed" });
    graph.attachReport({
      runId: "run-1",
      status: "completed",
      summary: "Three callers in src/",
      decisions: [],
      artifacts: [],
      risks: [],
      needsOperator: false,
      nextSuggestedTask: null,
    });

    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(2),
    );
    const [second] = spawnConductorChildSession.mock.calls[1];
    expect(second).toMatchObject({ stepIndex: 1, roleId: "qa" });
    expect(second.prompt).toContain("Three callers in src/");
  });

  it("shows the enumerated reason and spawns nothing for a broken fence", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", fence("{not json}"))]);

    runWaveEngineTick();

    expect(spawnConductorChildSession).not.toHaveBeenCalled();
    expect(noticeTexts()).toHaveLength(1);
    expect(noticeTexts()[0]).toContain(
      i18n.t("chat:conductor.wave.reason.malformedJson"),
    );
    const notice = conductorMessages().at(-1);
    expect(notice?.content[0]).toMatchObject({
      type: "systemNotification",
      notificationType: "error",
      action: { type: "retryWavePlan", sessionId: CONDUCTOR_ID },
    });
    expect(getWaveEngineState().waves).toHaveLength(0);
    expect(hasWaveTombstone(getWaveEngineState(), "plan-1")).toBe(true);
  });

  it("refuses the whole plan when a step's model resolves to nothing, before any spawn", () => {
    // 4a/D5: no seams are installed here, so the live inventory is empty and
    // the named model cannot be honoured — the honest outcome is a refusal of
    // the whole plan while nothing has started, never a silent inherit.
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([
      assistant(
        "plan-1",
        fence(
          '{"steps":[{"role":"scout","subtask":"Look","access":[]},{"role":"qa","subtask":"Check","access":[],"model":"gpt-5"}]}',
        ),
      ),
    ]);

    runWaveEngineTick();

    expect(spawnConductorChildSession).not.toHaveBeenCalled();
    expect(noticeTexts()[0]).toContain(
      i18n.t("chat:conductor.wave.reason.stepModelUnavailable", { step: 2 }),
    );
    expect(noticeTexts()[0]).toContain('"gpt-5"');
  });

  it("spawns a step on the exact model the plan named (4a)", async () => {
    setWaveStepTargetIoForTests({
      personas: () => [],
      providers: () => [{ id: "grok-acp", label: "Grok" }] as never,
      modelsForHarness: (harnessId) =>
        (harnessId === "grok-acp"
          ? [{ id: "grok-4-6", displayName: "Grok 4.6" }]
          : []) as never,
      rateLimits: () => [] as never,
    });
    try {
      useConductorGraphStore.getState().registerNode(conductorNode());
      setTranscript([
        assistant(
          "plan-1",
          fence(
            '{"steps":[{"role":"scout","subtask":"Look","access":[],"model":"grok"}]}',
          ),
        ),
      ]);

      runWaveEngineTick();
      await vi.waitFor(() =>
        expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
      );

      const [args] = spawnConductorChildSession.mock.calls[0];
      expect(args.executionTarget).toMatchObject({
        harnessId: "grok-acp",
        modelProviderId: "grok-acp",
        modelId: "grok-4-6",
      });
    } finally {
      resetWaveStepTargetIoForTests();
    }
  });

  it("never re-processes a plan message, however often the tick fires", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([
      assistant(
        "plan-1",
        fence('{"steps":[{"role":"scout","subtask":"Look","access":[]}]}'),
      ),
    ]);

    for (let index = 0; index < 5; index += 1) runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );
    for (let index = 0; index < 5; index += 1) runWaveEngineTick();
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
  });

  it("re-errors nothing when a broken fence is ticked repeatedly", () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", fence("{not json}"))]);
    for (let index = 0; index < 4; index += 1) runWaveEngineTick();
    expect(noticeTexts()).toHaveLength(1);
  });

  it("resumes a wave after a restart without spawning a second worker", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );

    // Restart: the process-local guards are gone, the persisted state is not.
    resetWaveRunnerForTests();
    resetWaveEngineStateCache();
    expect(window.localStorage.getItem(CONDUCTOR_WAVES_STORAGE_KEY)).toContain(
      "plan-1",
    );

    runWaveEngineTick();
    await Promise.resolve();
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
    expect(getWaveEngineState().waves[0].steps[0]).toMatchObject({
      phase: "spawned",
      sessionId: "child-0",
    });
  });

  it("respawns a step whose spawn died before its child existed", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([
      assistant(
        "plan-1",
        fence('{"steps":[{"role":"scout","subtask":"Look","access":[]}]}'),
      ),
    ]);
    spawnConductorChildSession.mockImplementation(
      () => new Promise(() => undefined),
    );
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );
    expect(getWaveEngineState().waves[0].steps[0].phase).toBe("spawning");

    resetWaveRunnerForTests();
    resetWaveEngineStateCache();
    spawnConductorChildSession.mockResolvedValue({
      sessionId: "child-0",
      runId: "run-9",
    });
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(2),
    );
  });

  it("fails a spawn that exceeds the timeout, and stops a late arrival", async () => {
    vi.useFakeTimers();
    try {
      useConductorGraphStore.getState().registerNode(conductorNode());
      setTranscript([
        assistant(
          "plan-1",
          fence('{"steps":[{"role":"scout","subtask":"Look","access":[]}]}'),
        ),
      ]);
      let resolveSpawn!: (value: { sessionId: string; runId: string }) => void;
      spawnConductorChildSession.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSpawn = resolve;
          }),
      );
      runWaveEngineTick();
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
      expect(getWaveEngineState().waves[0].steps[0].phase).toBe("spawning");

      await vi.advanceTimersByTimeAsync(WAVE_SPAWN_TIMEOUT_MS + 1);
      expect(getWaveEngineState().waves[0].steps[0].phase).toBe("failed");
      expect(noticeTexts().join("\n")).toContain("did not start");

      // The child that finally materializes is stopped, never adopted: the
      // operator was already told this step died (Q2, no auto-retry).
      resolveSpawn({ sessionId: "late-child", runId: "late-run" });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopOrchestratorSession).toHaveBeenCalledWith("late-child");
      expect(getWaveEngineState().waves[0].steps[0].phase).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a step failed and warns when its spawn throws", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    spawnConductorChildSession.mockRejectedValue(
      new Error("Conductor has no working folder yet."),
    );

    runWaveEngineTick();
    await vi.waitFor(() => expect(noticeTexts().length).toBeGreaterThan(0));
    expect(noticeTexts().join("\n")).toContain("no working folder");
    // The failed step does not block the access:"all" step behind it.
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(2),
    );
  });

  it("waits for a late report instead of handing dependents the unknown stub", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );

    // The run status flips to completed one tick before the report parse —
    // the routine race. The access:"all" step must NOT start on the stub.
    useConductorGraphStore
      .getState()
      .patchNode("child-0", { status: "completed" });
    runWaveEngineTick();
    await Promise.resolve();
    await Promise.resolve();
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);

    // The report lands. The dependent starts with the real findings.
    useConductorGraphStore.getState().attachReport({
      runId: "run-1",
      status: "completed",
      summary: "Real findings from step 0",
      decisions: [],
      artifacts: [],
      risks: [],
      needsOperator: false,
      nextSuggestedTask: null,
    });
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(2),
    );
    const [second] = spawnConductorChildSession.mock.calls[1];
    expect(second.prompt).toContain("Real findings from step 0");
    expect(second.prompt).not.toContain("Treat its result as unknown");
  });

  it("degrades to the unknown stub only after the report grace expires", async () => {
    vi.useFakeTimers();
    try {
      useConductorGraphStore.getState().registerNode(conductorNode());
      setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
      runWaveEngineTick();
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);

      // Completed, and the report never comes (a worker that finished without
      // emitting distill-report). The wave must still make progress — on the
      // stub, after the grace, with a wake-up the quiet app would not get
      // from store traffic.
      useConductorGraphStore
        .getState()
        .patchNode("child-0", { status: "completed" });
      runWaveEngineTick();
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(WAVE_REPORT_GRACE_MS + 200);
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(2);
      const [second] = spawnConductorChildSession.mock.calls[1];
      expect(second.prompt).toContain("Treat its result as unknown");

      // 5b: the downgrade is announced to the operator — once. The stub is
      // otherwise invisible until the digest, by which point the wave has
      // already spent every remaining step on top of it.
      const degradedNotice = i18n.t("chat:conductor.wave.reportDegraded", {
        step: 1,
        name: "child-0",
      });
      expect(
        noticeTexts().filter((text) => text === degradedNotice),
      ).toHaveLength(1);
      runWaveEngineTick();
      await vi.advanceTimersByTimeAsync(0);
      expect(
        noticeTexts().filter((text) => text === degradedNotice),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a child whose spawn resolves after the wave was stopped, instead of adopting it", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    stopOrchestratorSession.mockClear();
    let resolveSpawn: (value: { sessionId: string; runId: string }) => void =
      () => {};
    spawnConductorChildSession.mockImplementation(
      () =>
        new Promise<{ sessionId: string; runId: string }>((resolve) => {
          resolveSpawn = resolve;
        }),
    );
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );

    // The operator stops the wave while the spawn is still in flight. The
    // child session materializes anyway — sessions cannot be un-asked-for —
    // and must be stopped rather than adopted: an adopted child would run a
    // real prompt under a wave nothing will ever advance again.
    const { waveId } = getWaveEngineState().waves[0];
    expect(stopWaveByOperator(CONDUCTOR_ID, waveId)).toBe(true);

    resolveSpawn({ sessionId: "late-child", runId: "late-run" });
    await vi.waitFor(() =>
      expect(stopOrchestratorSession).toHaveBeenCalledWith("late-child"),
    );
    const wave = getWaveEngineState().waves.find(
      (candidate) => candidate.waveId === waveId,
    );
    expect(wave?.phase).toBe("needsOperator");
    expect(wave?.steps[0]?.phase).toBe("spawning");
  });

  it("never prunes waves while the graph knows no conductors at all", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );
    expect(getWaveEngineState().waves).toHaveLength(1);

    // A corrupt graph key or a hydration gap looks exactly like this: the
    // graph store comes up empty while the wave store still has live waves.
    // Treating it as "every conductor was deleted" erased them (risk №3).
    useConductorGraphStore.setState({ nodesById: {} });
    for (let index = 0; index < 3; index += 1) runWaveEngineTick();
    expect(getWaveEngineState().waves).toHaveLength(1);
  });

  it("prunes an orphaned wave only on its second consecutive orphaned tick", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );

    // The conductor vanishes from the graph while OTHER conductors remain —
    // the one shape where pruning is legitimate. First tick: survives (the
    // draft-id remap can hide a conductor for exactly one tick). Second tick:
    // pruned.
    useConductorGraphStore.setState({
      nodesById: {
        other: { ...conductorNode(), sessionId: "other" },
        "child-0": useConductorGraphStore.getState().nodesById["child-0"],
      },
    });
    runWaveEngineTick();
    expect(getWaveEngineState().waves).toHaveLength(1);
    runWaveEngineTick();
    expect(getWaveEngineState().waves).toHaveLength(0);
    // The prune erased the wave; its telemetry record is the only trace left.
    expect(getWaveTelemetry().records[0]).toMatchObject({ outcome: "pruned" });
  });

  it("keeps an orphaned wave whose conductor reappears between ticks", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );

    const nodes = useConductorGraphStore.getState().nodesById;
    // One orphaned tick (remap in flight)…
    useConductorGraphStore.setState({
      nodesById: {
        other: { ...conductorNode(), sessionId: "other" },
        "child-0": nodes["child-0"],
      },
    });
    runWaveEngineTick();
    // …then the conductor is back. The wave must still be there.
    useConductorGraphStore.setState({
      nodesById: {
        ...useConductorGraphStore.getState().nodesById,
        [CONDUCTOR_ID]: nodes[CONDUCTOR_ID],
      },
    });
    runWaveEngineTick();
    runWaveEngineTick();
    expect(getWaveEngineState().waves).toHaveLength(1);
  });

  it("refuses a second wave while the first one is still live (§4.1)", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );

    // Ninety seconds in, the operator adds "also, while you're in there…".
    // The conductor answers the only way it was told to: with another plan.
    setTranscript([...conductorMessages(), assistant("plan-2", TWO_STEP_PLAN)]);
    runWaveEngineTick();
    await Promise.resolve();
    await Promise.resolve();

    // Nothing new was spawned into the same working folder…
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
    expect(getWaveEngineState().waves).toHaveLength(1);
    // …the operator is told, in their own language, what happened and what to
    // do instead…
    expect(noticeTexts().join("\n")).toContain(
      i18n.t("chat:conductor.wave.concurrent.title"),
    );
    expect(noticeTexts().join("\n")).toContain(
      i18n.t("chat:conductor.wave.concurrent.body"),
    );
    // …and the refusal is tombstoned, so it is not repeated on every tick.
    expect(hasWaveTombstone(getWaveEngineState(), "plan-2")).toBe(true);
    for (let index = 0; index < 4; index += 1) runWaveEngineTick();
    expect(noticeTexts()).toHaveLength(1);
  });

  it("keeps one refusal card per wave and counts the plans it refused", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );

    // A message queue drained after a restart delivers several requests at
    // once, and the conductor answers each of them with a plan.
    for (const planId of ["plan-2", "plan-3", "plan-4"]) {
      setTranscript([...conductorMessages(), assistant(planId, TWO_STEP_PLAN)]);
      runWaveEngineTick();
      await Promise.resolve();
      await Promise.resolve();
    }

    // Every plan is still refused and tombstoned — that is the audit fact…
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
    for (const planId of ["plan-2", "plan-3", "plan-4"]) {
      expect(hasWaveTombstone(getWaveEngineState(), planId)).toBe(true);
    }
    // …but the operator reads one card, carrying the count, not three walls.
    expect(noticeTexts()).toHaveLength(1);
    expect(noticeTexts()[0]).toContain(
      i18n.t("chat:conductor.wave.concurrent.refusedCount", { count: 3 }),
    );
  });

  it("admits a new plan once the conductor's wave is no longer live", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );

    // A wave parked on `needsOperator` is a record backing the retry, not work
    // in flight, so a new root request replaces it exactly as it did before.
    const parked = getWaveEngineState().waves[0];
    setWaveEngineState(
      withWave(getWaveEngineState(), {
        ...parked,
        phase: "needsOperator",
      }),
    );

    setTranscript([...conductorMessages(), assistant("plan-2", TWO_STEP_PLAN)]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(2),
    );
    const waves = getWaveEngineState().waves;
    expect(waves).toHaveLength(1);
    expect(waves[0].planMessageId).toBe("plan-2");
  });

  it('leaves old managedBy:"ui" children alone', () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    useConductorGraphStore.getState().registerNode({
      sessionId: "legacy-1",
      projectId: "project",
      role: "worker",
      managedBy: "ui",
      parentSessionId: CONDUCTOR_ID,
      rootConductorId: CONDUCTOR_ID,
      runId: "run-legacy",
      harnessId: "goose",
      displayName: "Legacy",
      status: "completed",
    });
    setTranscript([assistant("chat-1", "Just an answer, no fence.")]);

    runWaveEngineTick();

    expect(spawnConductorChildSession).not.toHaveBeenCalled();
    expect(getWaveEngineState().waves).toHaveLength(0);
    expect(noticeTexts()).toEqual([]);
  });
});
