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

/** Calls through to the real resolver; exists so a test can see its inputs. */
const resolveWaveStepTarget = vi.hoisted(() =>
  vi.fn<(roleId: string, classId?: string) => unknown>(),
);

vi.mock("./waveStepTarget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./waveStepTarget")>();
  resolveWaveStepTarget.mockImplementation((roleId, classId) =>
    actual.resolveWaveStepTarget(roleId, classId as never),
  );
  return { ...actual, resolveWaveStepTarget };
});

const {
  WAVE_SPAWN_TIMEOUT_MS,
  WAVE_STALL_SAMPLE_MS,
  WAVE_STALL_THRESHOLD,
  resetWaveRunnerForTests,
  runWaveEngineTick,
} = await import("./waveRunner");
const {
  CONDUCTOR_WAVES_STORAGE_KEY,
  getWaveEngineState,
  hasWaveTombstone,
  resetWaveEngineStateCache,
  setWaveEngineState,
  setWaveEngineStateHydratedForTests,
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

/**
 * Conductor turns are minutes apart in life, and the engine now remembers the
 * newest message it has handled per conductor, so every helper message gets
 * its own time rather than all of them sharing one.
 */
let createdClock = 1_000;

function nextCreated(): number {
  createdClock += 1_000;
  return createdClock;
}

function assistant(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    created: nextCreated(),
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
    createdClock = 1_000;
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

  it("stays off for the session when a folder document could not be read", async () => {
    // A waves.json that never loaded has no tombstones in it: a tick would
    // read every plan in the transcript as new and spawn its workers again.
    // The hydration gave up, the waiter was released, and the engine's answer
    // is to sit out — not to run on the empty copy.
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    setWaveEngineStateHydratedForTests(false);
    try {
      runWaveEngineTick();
      setWaveEngineStateHydratedForTests("failed");
      runWaveEngineTick();
      await Promise.resolve();
      expect(spawnConductorChildSession).not.toHaveBeenCalled();
      expect(getWaveEngineState().waves).toHaveLength(0);
    } finally {
      setWaveEngineStateHydratedForTests(null);
    }
  });

  it("does not re-admit an old plan once its tombstone has been evicted", async () => {
    // The tombstone list is capped at 500 and every wave spends at least two
    // entries, so a heavy user's oldest plans fall off it. Reopening that chat
    // replays its transcript, and the watermark is what keeps a months-old
    // plan from being read as a brand-new root request and spawning workers.
    useConductorGraphStore.getState().registerNode(conductorNode());
    const oldPlan = { ...assistant("plan-old", TWO_STEP_PLAN), created: 1_000 };
    const newPlan = { ...assistant("plan-new", TWO_STEP_PLAN), created: 5_000 };
    setTranscript([oldPlan, newPlan]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(getWaveEngineState().waves[0]?.steps[0]?.sessionId).toBe(
        "child-0",
      ),
    );
    expect(getWaveEngineState().waves).toHaveLength(1);
    const spawnsSoFar = spawnConductorChildSession.mock.calls.length;

    // The cap evicts both tombstones and the wave closes: the only record left
    // of either message is the watermark. The graph is as a much later session
    // finds it — the old wave's children are long gone from it too.
    setWaveEngineState({
      ...getWaveEngineState(),
      waves: [],
      tombstones: [],
    });
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    useConductorGraphStore.getState().registerNode(conductorNode());
    resetWaveRunnerForTests();
    runWaveEngineTick();
    await Promise.resolve();
    expect(getWaveEngineState().waves).toHaveLength(0);
    expect(spawnConductorChildSession.mock.calls).toHaveLength(spawnsSoFar);

    // A plan the conductor writes now is newer than the mark and still runs.
    setTranscript([
      oldPlan,
      newPlan,
      { ...assistant("plan-next", TWO_STEP_PLAN), created: 9_000 },
    ]);
    runWaveEngineTick();
    await Promise.resolve();
    expect(
      getWaveEngineState().waves.map((wave) => wave.planMessageId),
    ).toEqual(["plan-next"]);
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

  it("stops the wave the way the operator's stop does when a step reports blocked", async () => {
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
      status: "blocked",
      reason: "the callers file the subtask names does not exist",
      summary: "Could not start",
      decisions: [],
      artifacts: [],
      risks: [],
      needsOperator: true,
      nextSuggestedTask: null,
    });

    runWaveEngineTick();

    // Parked first, like 5b: the scheduler never advances this wave again,
    // and no digest or verdict is ever produced for it.
    expect(getWaveEngineState().waves[0]?.phase).toBe("needsOperator");
    // The satisfied access:"all" successor was never spawned…
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
    // …the blocked child itself already finished, so it is not "stopped"
    // after the fact (that would relabel its completed run as cancelled)…
    expect(stopOrchestratorSession).not.toHaveBeenCalledWith("child-0");
    // …and the operator can read which step blocked and why, in the worker's
    // own words.
    const notice = noticeTexts().at(-1);
    expect(notice).toContain(
      i18n.t("chat:conductor.wave.stepBlocked", { step: 1, name: "child-0" }),
    );
    expect(notice).toContain(
      "the callers file the subtask names does not exist",
    );
    // The close leaves the same kind of record as the operator's stop.
    expect(getWaveTelemetry().records[0]).toMatchObject({
      outcome: "needs-operator",
      closureReason: "step-blocked",
    });

    // Re-ticking neither respawns nor re-announces: the persisted phase is
    // the idempotency, exactly as it is for 5b.
    const noticeCount = noticeTexts().length;
    runWaveEngineTick();
    runWaveEngineTick();
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
    expect(noticeTexts()).toHaveLength(noticeCount);
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

  it("spawns a step with the budget, class, effort and fast mode the plan gave it (P49/P36)", async () => {
    // The plan's ceiling is what the budget guard stops the child on, the
    // class is what routes it, and effort and fast mode are how the child
    // runs. All are parsed at admission and only used at spawn, which is
    // rebuilt from the persisted wave — so this is the whole path, not the
    // parser.
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([
      assistant(
        "plan-1",
        fence(
          '{"steps":[{"role":"scout","subtask":"Look","access":[],"budget":{"minutes":5,"tokens":20000},"class":"coding-simple","effort":"high","fast":false}]}',
        ),
      ),
    ]);

    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );

    const [args] = spawnConductorChildSession.mock.calls[0];
    expect(args.budget).toEqual({ minutes: 5, tokens: 20000 });
    expect(args.runSettings).toEqual({ effort: "high", fast: false });
    expect(resolveWaveStepTarget).toHaveBeenCalledWith(
      "scout",
      "coding-simple",
    );
    // The persisted record carries all of them, so a restart resumes the
    // same step.
    expect(getWaveEngineState().waves[0]?.steps[0]).toMatchObject({
      budget: { minutes: 5, tokens: 20000 },
      modelClass: "coding-simple",
      effort: "high",
      fast: false,
    });
  });

  it("refuses the whole plan when a step names an effort its model does not offer, before any spawn", async () => {
    setWaveStepTargetIoForTests({
      personas: () => [],
      providers: () => [{ id: "grok-acp", label: "Grok" }] as never,
      modelsForHarness: (harnessId) =>
        (harnessId === "grok-acp"
          ? [
              {
                id: "grok-4-6",
                displayName: "Grok 4.6",
                efforts: [{ id: "low" }, { id: "high" }],
                supportsFast: false,
              },
            ]
          : []) as never,
      rateLimits: () => [] as never,
    });
    try {
      useConductorGraphStore.getState().registerNode(conductorNode());
      setTranscript([
        assistant(
          "plan-1",
          fence(
            '{"steps":[{"role":"scout","subtask":"Look","access":[]},{"role":"qa","subtask":"Check","access":[],"model":"grok","effort":"xhigh"}]}',
          ),
        ),
      ]);

      runWaveEngineTick();
      await Promise.resolve();

      expect(spawnConductorChildSession).not.toHaveBeenCalled();
      expect(getWaveEngineState().waves).toHaveLength(0);
      expect(noticeTexts()[0]).toContain(
        i18n.t("chat:conductor.wave.reason.stepRunSettingsUnavailable", {
          step: 2,
        }),
      );
      expect(noticeTexts()[0]).toContain("it offers low, high");
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
});

describe("wave stall detector (P61)", () => {
  beforeEach(async () => {
    await i18n.loadNamespaces("chat");
    createdClock = 1_000;
    window.localStorage.clear();
    resetWaveEngineStateCache();
    resetWaveRunnerForTests();
    resetWaveStepTargetIoForTests();
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    useChatStore.setState({ messagesBySession: {} });
    useChatSessionStore.setState({ hasHydratedSessions: true } as never);
    spawnConductorChildSession.mockReset();
    spawnConductorChildSession.mockImplementation(
      async (args: { waveId?: string; stepIndex?: number }) => {
        const sessionId = `child-${args.stepIndex ?? 0}`;
        const runId = `run-${args.stepIndex ?? 0}`;
        registerSpawnedChild({
          sessionId,
          waveId: args.waveId ?? "",
          stepIndex: args.stepIndex ?? 0,
          runId,
        });
        return { sessionId, runId };
      },
    );
    stopOrchestratorSession.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends a silently wedged wave into the digest cycle, saying why", async () => {
    vi.useFakeTimers();
    try {
      useConductorGraphStore.getState().registerNode(conductorNode());
      setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
      runWaveEngineTick();
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);

      // The child neither streams nor changes status: total silence. Each
      // full sample window adds one stall count; at the threshold the wave
      // is cut into digestPending — not parked, not retried.
      for (let i = 0; i < WAVE_STALL_THRESHOLD; i += 1) {
        await vi.advanceTimersByTimeAsync(WAVE_STALL_SAMPLE_MS + 200);
      }
      const wave = getWaveEngineState().waves[0];
      // Out of `running` and marked stalled. The digest machinery advances
      // further within the same tick; in this harness its dispatch has no
      // transport, so the exact terminal phase is the lifecycle's business
      // (waveLifecycle.test.ts) — what P61 owns is the cut itself.
      expect(wave?.stalled).toBe(true);
      expect(wave?.phase).not.toBe("running");
      // The wedged child was told to stop, and the operator was told why.
      expect(stopOrchestratorSession).toHaveBeenCalled();
      expect(
        noticeTexts().some((text) => text.includes("stopped making progress")),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
