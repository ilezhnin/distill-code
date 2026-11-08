import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ApplicationExecutorRequest,
  ExecutorDecision,
  ExecutorDecisionRecord,
} from "@/features/benchmarks/lib/executorSelection";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { SessionRunSettings } from "@/features/chat/lib/sessionRunSettings";
import { useBackgroundTasksStore } from "@/features/chat/stores/backgroundTasksStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";
import { i18n } from "@/shared/i18n";
import {
  markAppClosing,
  resetAppClosingForTests,
} from "@/shared/lib/appClosing";
import type { Message } from "@/shared/types/messages";

import { useConductorGraphStore } from "./conductorGraphStore";
import type { SessionNode } from "./types";
import { RUN_FALLBACK_SUMMARIES } from "./orchestratorReport";
import { roleDisplayName } from "./roleLayers";
import {
  resetWaveStepTargetIoForTests,
  setWaveStepTargetIoForTests,
} from "./waveStepTarget";

const executorSelection = vi.hoisted(() => ({
  get: vi.fn<(key: string) => Promise<ExecutorDecisionRecord | null>>(),
  select:
    vi.fn<
      (
        request: ApplicationExecutorRequest,
        record: boolean,
      ) => Promise<ExecutorDecision>
    >(),
  observe: vi.fn<(key: string, observation: unknown) => Promise<void>>(
    async (_key: string, _observation: unknown) => undefined,
  ),
  syncOutcome: vi.fn(
    async (_key: string, _session: string, _run: string, _outcome: string) =>
      undefined,
  ),
}));
function decisionFor(request: ApplicationExecutorRequest): ExecutorDecision {
  return {
    request: {
      requestKey: request.requestKey,
      surface: request.surface,
      contextId: request.contextId,
      prediction: {
        task: request.task,
        targetFamily: request.targetFamily,
        targetGroup: request.targetGroup,
        candidates: request.candidates,
        hardCandidateKey: request.hardCandidateId,
        minQuality: request.minQuality,
      },
      priorKeys: request.priorIds,
      modelId: request.modelId,
    },
    chosen:
      request.candidates.find((row) => row.available)?.configuration ?? null,
    chosenKey: null,
    source: request.hardCandidateId ? "pin" : "prior",
    reason: "persona_prior",
    createdAt: 0,
    inputHash: "fixture",
    artifactHash: "fixture",
    policyVersion: "fixture",
    learnedStatus: "not_requested",
    researchPrediction: null,
    learnedDispatchAllowed: false,
  };
}
beforeEach(() => {
  executorSelection.get.mockReset().mockResolvedValue(null);
  executorSelection.select
    .mockReset()
    .mockImplementation(async (request) => decisionFor(request));
  executorSelection.observe.mockReset().mockResolvedValue(undefined);
  executorSelection.syncOutcome.mockReset().mockResolvedValue(undefined);
});
vi.mock("@/features/benchmarks/lib/executorSelection", () => ({
  executorSelection,
}));
vi.mock("@/features/benchmarks/lib/ownedTaskExecution", () => ({
  ownedTaskExecution: {
    getMode: vi.fn(async () => null),
    cancel: vi.fn(async () => undefined),
  },
}));

const spawnConductorChildSession = vi.hoisted(() => vi.fn());

vi.mock("./spawnOrchestrator", () => ({ spawnConductorChildSession }));

const stopOrchestratorSession = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./orchestratorControls", () => ({ stopOrchestratorSession }));

/**
 * Every message the engine sends a conductor — digests, blocked-step notes —
 * goes through this one seam; the tests read what was sent from its calls.
 */
const deliverEnvelope = vi.hoisted(() =>
  vi.fn(async (_sessionId: string, _text: string) => ({
    status: "queued" as const,
  })),
);

vi.mock("./digestDelivery", () => ({ deliverEnvelope }));

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
  setWaveRoutingInputsReadyForTests,
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

function queuedTexts(): string[] {
  return deliverEnvelope.mock.calls
    .filter(([sessionId]) => sessionId === CONDUCTOR_ID)
    .map(([, text]) => text);
}

function noticeTexts(): string[] {
  return conductorMessages().flatMap((message) =>
    message.content.flatMap((block) =>
      block.type === "systemNotification" ? [block.text] : [],
    ),
  );
}

/**
 * Children named by wave and step, for tests that run several waves at once:
 * the default mock names them by step alone, and two waves' first steps would
 * share one graph node.
 */
function spawnChildrenPerWave(): void {
  spawnConductorChildSession.mockImplementation(async (args) => {
    const sessionId = `${args.waveId}-child-${args.stepIndex}`;
    const runId = `run-${sessionId}`;
    registerSpawnedChild({
      sessionId,
      waveId: args.waveId,
      stepIndex: args.stepIndex,
      runId,
    });
    return { sessionId, runId };
  });
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
    deliverEnvelope.mockClear();
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
    resetWaveStepTargetIoForTests();
    resetAppClosingForTests();
  });

  function selectionPlan(
    explicit = false,
    options: {
      secondSettings?: SessionRunSettings | null;
      unsupportedSettings?: boolean;
      advertisedEfforts?: boolean;
    } = {},
  ): void {
    const secondSettings =
      options.secondSettings === null
        ? undefined
        : (options.secondSettings ?? { effort: "high" });
    setWaveStepTargetIoForTests({
      personas: () => [
        {
          id: "scout",
          displayName: "Scout",
          systemPrompt: "Inspect the sample project.",
          isBuiltin: false,
          writable: true,
          modelRanking: JSON.stringify({
            version: 1,
            entries: [
              {
                platform: "codex-acp",
                modelId: "example-one",
                label: "One",
                effort: "low",
              },
              {
                platform: "codex-acp",
                modelId: "example-two",
                label: "Two",
                ...(secondSettings?.effort
                  ? { effort: secondSettings.effort }
                  : {}),
                ...(secondSettings?.fast !== undefined
                  ? { fastMode: secondSettings.fast }
                  : {}),
              },
            ],
          }),
        },
      ],
      providers: () => [{ id: "codex-acp", label: "Example" }] as never,
      modelsForHarness: () => [
        {
          id: "example-one",
          name: "One",
          displayName: "One",
          ...(options.advertisedEfforts
            ? {
                supportsFast: true,
                efforts: [
                  { id: "low", name: "Low" },
                  { id: "high", name: "High" },
                ],
              }
            : {}),
          ...(options.unsupportedSettings
            ? { efforts: [{ id: "high", name: "High" }], supportsFast: false }
            : {}),
        },
        {
          id: "example-two",
          name: "Two",
          displayName: "Two",
          ...(options.advertisedEfforts
            ? {
                supportsFast: true,
                efforts: [
                  { id: "low", name: "Low" },
                  { id: "high", name: "High" },
                ],
              }
            : {}),
          ...(options.unsupportedSettings
            ? { efforts: [{ id: "low", name: "Low" }], supportsFast: false }
            : {}),
        },
      ],
      rateLimits: () => [],
      conductorTarget: () => undefined,
    });
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([
      assistant(
        "selection-plan",
        fence(
          JSON.stringify({
            steps: [
              {
                role: "scout",
                subtask: "Inspect the sample input",
                access: [],
                ...(explicit ? { model: "example-two" } : {}),
              },
            ],
          }),
        ),
      ),
    ]);
  }

  it("records the preference pool and reconciles dispatch notices with the returned model and settings", async () => {
    selectionPlan(false, {
      secondSettings: { effort: "high", fast: true },
      unsupportedSettings: true,
    });
    executorSelection.select.mockImplementationOnce(async (request, record) => {
      expect(record).toBe(true);
      expect(spawnConductorChildSession).not.toHaveBeenCalled();
      expect(noticeTexts()).toEqual([]);
      expect(
        request.candidates.slice(0, 2).map((row) => row.configuration.modelId),
      ).toEqual(["example-one", "example-two"]);
      expect(request.task).toMatchObject({
        rolePrompt: "Inspect the sample project.",
        executionProfile: "interactive_acp",
      });
      return {
        ...decisionFor(request),
        chosen: request.candidates[1].configuration,
      };
    });
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(getWaveEngineState().waves[0]?.steps[0]?.phase).toBe("spawned"),
    );
    expect(spawnConductorChildSession.mock.calls[0][0]).toMatchObject({
      executorDecisionKey: executorSelection.select.mock.calls[0][0].requestKey,
      executionTarget: { modelId: "example-two" },
      runSettings: { effort: "high", fast: true },
    });
    expect(noticeTexts()).toEqual([
      i18n.t("chat:conductor.wave.stepModel.selected", {
        step: 1,
        name: roleDisplayName("scout"),
        model: "Two",
      }),
      i18n.t("chat:conductor.wave.stepModel.effortNotApplied", {
        step: 1,
        name: roleDisplayName("scout"),
        model: "Two",
        effort: "high",
      }),
      i18n.t("chat:conductor.wave.stepModel.fastNotApplied", {
        step: 1,
        name: roleDisplayName("scout"),
        model: "Two",
      }),
    ]);
    expect(executorSelection.observe).toHaveBeenCalledWith(
      executorSelection.select.mock.calls[0][0].requestKey,
      expect.objectContaining({
        phase: "started",
        sessionId: "child-0",
        runId: "run-1",
        // The journal records what actually ran, not a blank.
        configuration: expect.objectContaining({ id: expect.any(String) }),
      }),
    );
  });

  it("launches a certified advertised effort choice with unchanged interactive provenance", async () => {
    selectionPlan(false, { advertisedEfforts: true });
    executorSelection.select.mockImplementationOnce(async (request) => {
      const chosen = request.candidates.find(
        (row) =>
          row.configuration.modelId === "example-two" &&
          row.configuration.effort === "low" &&
          row.configuration.fastMode === false,
      );
      if (!chosen) throw new Error("Advertised effort candidate is missing");
      expect(chosen?.available).toBe(true);
      expect(chosen?.configuration).toMatchObject({
        providerId: "codex-acp",
        inventoryRevision: null,
        billingMode: "unknown",
        executionProfile: "interactive_acp",
      });
      expect(request.priorIds).not.toContain(chosen?.configuration.id);
      return {
        ...decisionFor(request),
        chosen: chosen.configuration,
        source: "learned",
        learnedStatus: "certified_class_policy",
        learnedDispatchAllowed: true,
      };
    });
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledOnce(),
    );
    expect(spawnConductorChildSession.mock.calls[0][0]).toMatchObject({
      executionTarget: { harnessId: "codex-acp", modelId: "example-two" },
      runSettings: { effort: "low", fast: false },
    });
  });

  it("keeps a selected model's unspecified settings instead of borrowing the baseline effort", async () => {
    selectionPlan(false, { secondSettings: null });
    executorSelection.select.mockImplementationOnce(async (request) => ({
      ...decisionFor(request),
      chosen: request.candidates[1].configuration,
    }));
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );
    const args = spawnConductorChildSession.mock.calls[0][0];
    expect(args.executionTarget.modelId).toBe("example-two");
    expect(args).not.toHaveProperty("runSettings");
    expect(noticeTexts()).toEqual([
      i18n.t("chat:conductor.wave.stepModel.selected", {
        step: 1,
        name: roleDisplayName("scout"),
        model: "Two",
      }),
    ]);
  });

  it("dispatches a new session under a numbered key when the record names a session the graph holds as ended", async () => {
    selectionPlan();
    // The session the record names was the step's executor before a restart
    // ended it; the graph still holds its node, stopped. Adopting it would
    // hand the step a dead worker — on 2026-11-01 that parked a live wave as
    // interrupted thirteen seconds after the app came back.
    registerSpawnedChild({
      sessionId: "dead-child",
      waveId: "elsewhere",
      stepIndex: 9,
      runId: "dead-run",
      status: "stopped",
    });
    executorSelection.get.mockImplementation(async (key) =>
      key.endsWith(":attempt:1")
        ? null
        : ({
            decision: null,
            hostExecution: null,
            observations: [
              {
                observation: {
                  phase: "started",
                  sessionId: "dead-child",
                  runId: "dead-run",
                },
              },
            ],
          } as unknown as ExecutorDecisionRecord),
    );
    spawnConductorChildSession.mockImplementation(async (args) => {
      const sessionId = `child-${args.stepIndex}`;
      registerSpawnedChild({
        sessionId,
        waveId: args.waveId,
        stepIndex: args.stepIndex,
        runId: "run-1",
      });
      // The live graph sync ticks on the registration, adopting the node
      // before this spawn's ACK reaches the runner.
      runWaveEngineTick();
      return { sessionId, runId: "run-1" };
    });
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );
    expect(
      spawnConductorChildSession.mock.calls[0][0].executorDecisionKey,
    ).toMatch(/:attempt:1$/);
    await vi.waitFor(() =>
      expect(getWaveEngineState().waves[0]?.steps[0]).toMatchObject({
        phase: "spawned",
        sessionId: "child-0",
        executorKey: expect.stringMatching(/:attempt:1$/),
      }),
    );
  });

  it("does not redispatch a step with a durable execution record after a restart", async () => {
    selectionPlan();
    executorSelection.get.mockResolvedValueOnce({
      observations: [{ observation: { phase: "started" } }],
    } as ExecutorDecisionRecord);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(getWaveEngineState().waves[0]?.steps[0]?.phase).toBe("failed"),
    );
    expect(executorSelection.select).not.toHaveBeenCalled();
    expect(spawnConductorChildSession).not.toHaveBeenCalled();
  });

  it("resumes a spawn that died between deciding and starting on the decision already recorded", async () => {
    selectionPlan();
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(getWaveEngineState().waves[0]?.steps[0]?.phase).toBe("spawned"),
    );
    const decided = executorSelection.select.mock.results[0]?.value;
    if (!decided) throw new Error("the first spawn decided nothing");
    const decision = await decided;
    const firstSpawn = spawnConductorChildSession.mock.calls[0][0];

    // The renderer went down right after the host recorded the decision and
    // before the child registered: the step comes back `spawning` with no
    // node, and the host answers the key with the decision it already holds.
    const wave = getWaveEngineState().waves[0];
    setWaveEngineState({
      ...getWaveEngineState(),
      waves: [
        {
          ...wave,
          steps: wave.steps.map((step) =>
            step.stepIndex === 0
              ? { ...step, phase: "spawning", sessionId: undefined }
              : step,
          ),
        },
      ],
    });
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    useConductorGraphStore.getState().registerNode(conductorNode());
    resetWaveRunnerForTests();
    executorSelection.get.mockResolvedValueOnce({
      decision,
      observations: [],
      hostExecution: null,
    });
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(2),
    );
    // Decided once: the host would refuse the key with changed inputs, and the
    // worker runs on the same model the first attempt chose.
    expect(executorSelection.select).toHaveBeenCalledTimes(1);
    expect(spawnConductorChildSession.mock.calls[1][0]).toMatchObject({
      executorDecisionKey: firstSpawn.executorDecisionKey,
      executionTarget: firstSpawn.executionTarget,
    });
    await vi.waitFor(() =>
      expect(getWaveEngineState().waves[0]?.steps[0]?.phase).toBe("spawned"),
    );
  });

  it("refuses a host dispatch even if the renderer lost its started observation", async () => {
    selectionPlan();
    executorSelection.get.mockResolvedValueOnce({
      observations: [],
      hostExecution: { start: { hostRunId: "native-run" }, finish: null },
    } as unknown as ExecutorDecisionRecord);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(getWaveEngineState().waves[0]?.steps[0]?.phase).toBe("failed"),
    );
    expect(executorSelection.select).not.toHaveBeenCalled();
    expect(spawnConductorChildSession).not.toHaveBeenCalled();
  });

  it("bounds selection time and closes a late decision without spawning", async () => {
    vi.useFakeTimers();
    try {
      selectionPlan();
      let release!: (value: ExecutorDecision) => void;
      executorSelection.select.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      runWaveEngineTick();
      await vi.advanceTimersByTimeAsync(WAVE_SPAWN_TIMEOUT_MS + 1);
      expect(getWaveEngineState().waves[0]?.steps[0]?.phase).toBe("failed");
      release(decisionFor(executorSelection.select.mock.calls[0][0]));
      await vi.advanceTimersByTimeAsync(0);
      expect(executorSelection.observe).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ phase: "terminal", outcome: "failed" }),
      );
      expect(spawnConductorChildSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rechecks ranked inventory after selection without silently choosing another model", async () => {
    selectionPlan();
    executorSelection.select.mockImplementationOnce(async (request) => {
      setWaveStepTargetIoForTests({ modelsForHarness: () => [] });
      return decisionFor(request);
    });
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(getWaveEngineState().waves[0]?.steps[0]?.phase).toBe("failed"),
    );
    expect(spawnConductorChildSession).not.toHaveBeenCalled();
  });

  it("sends an explicit model as a hard pin without role alternatives", async () => {
    selectionPlan(true);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );
    const input = executorSelection.select.mock.calls[0][0];
    expect(input.candidates).toHaveLength(1);
    expect(input.hardCandidateId).toBe(input.candidates[0].configuration.id);
    expect(input.candidates[0].configuration.modelId).toBe("example-two");
  });

  it("does not dispatch when selection storage fails", async () => {
    selectionPlan();
    executorSelection.select.mockRejectedValueOnce(
      new Error("decision store unavailable"),
    );
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(getWaveEngineState().waves[0]?.steps[0]?.phase).toBe("failed"),
    );
    expect(spawnConductorChildSession).not.toHaveBeenCalled();
    expect(noticeTexts().join(" ")).toContain("decision store unavailable");
  });

  it("cancels a prepared decision if the wave is stopped while storage is pending", async () => {
    selectionPlan();
    let release!: (value: ExecutorDecision) => void;
    executorSelection.select.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(executorSelection.select).toHaveBeenCalledTimes(1),
    );
    stopWaveByOperator(CONDUCTOR_ID, getWaveEngineState().waves[0].waveId);
    release(decisionFor(executorSelection.select.mock.calls[0][0]));
    await vi.waitFor(() =>
      expect(executorSelection.observe).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          phase: "terminal",
          outcome: "cancelled",
          configuration: null,
        }),
      ),
    );
    expect(spawnConductorChildSession).not.toHaveBeenCalled();
  });

  it("refuses a pinned model that disappears during selection", async () => {
    selectionPlan(true);
    executorSelection.select.mockImplementationOnce(async (request) => {
      setWaveStepTargetIoForTests({ modelsForHarness: () => [] });
      return decisionFor(request);
    });
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(getWaveEngineState().waves[0]?.steps[0]?.phase).toBe("failed"),
    );
    expect(spawnConductorChildSession).not.toHaveBeenCalled();
    expect(executorSelection.observe).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ outcome: "failed" }),
    );
  });

  it("reconciles a terminal run without inventing an observed configuration or dispatching again", async () => {
    selectionPlan();
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(getWaveEngineState().waves[0]?.steps[0]?.phase).toBe("spawned"),
    );
    const decision = decisionFor(executorSelection.select.mock.calls[0][0]);
    executorSelection.get.mockResolvedValue({
      decision,
      observations: [],
      hostExecution: null,
    });
    useConductorGraphStore
      .getState()
      .patchNode("child-0", { status: "completed" });
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(executorSelection.syncOutcome).toHaveBeenCalledWith(
        decision.request.requestKey,
        "child-0",
        "run-1",
        "completed",
      ),
    );
    runWaveEngineTick();
    expect(executorSelection.syncOutcome).toHaveBeenCalledTimes(1);
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
  });

  it("late spawn bookkeeping cannot stop a child whose wave already reached its digest", async () => {
    selectionPlan();
    stopOrchestratorSession.mockClear();
    let finishBookkeeping!: () => void;
    executorSelection.observe.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishBookkeeping = resolve;
        }),
    );
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(executorSelection.observe).toHaveBeenCalled(),
    );
    const graph = useConductorGraphStore.getState();
    graph.patchNode("child-0", { status: "completed" });
    graph.attachReport({
      runId: "run-1",
      status: "completed",
      summary: "Completed before bookkeeping",
      decisions: ["No artifacts changed"],
      artifacts: [],
      risks: [],
      needsOperator: false,
      nextSuggestedTask: null,
    });
    runWaveEngineTick();
    expect(getWaveEngineState().waves[0]?.phase).toBe("dispatchingDigest");
    const decision = decisionFor(executorSelection.select.mock.calls[0][0]);
    executorSelection.get.mockResolvedValue({
      decision,
      observations: [],
      hostExecution: null,
    });
    finishBookkeeping();
    await vi.waitFor(() =>
      expect(executorSelection.syncOutcome).toHaveBeenCalled(),
    );
    expect(stopOrchestratorSession).not.toHaveBeenCalled();
    expect(graph.getNode("child-0")?.status).toBe("completed");
    expect(getWaveEngineState().waves[0]?.steps[0]).toMatchObject({
      phase: "spawned",
      sessionId: "child-0",
      runId: "run-1",
    });
  });

  it("late spawn bookkeeping preserves a failed step and its verification while its wave is running", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    let finishBookkeeping!: () => void;
    executorSelection.observe.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishBookkeeping = resolve;
        }),
    );
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(executorSelection.observe).toHaveBeenCalled(),
    );
    useConductorGraphStore
      .getState()
      .patchNode("child-0", { status: "completed" });
    // A verified report can be committed by graph/engine synchronization before
    // the spawn caller's slow attribution IPC returns.
    const current = getWaveEngineState();
    setWaveEngineState({
      ...current,
      waves: current.waves.map((wave) => ({
        ...wave,
        steps: wave.steps.map((step) =>
          step.stepIndex === 0
            ? {
                ...step,
                phase: "failed" as const,
                sessionId: "child-0",
                runId: "run-1",
                reportVerified: true,
              }
            : step,
        ),
      })),
    });
    const decision = decisionFor(executorSelection.select.mock.calls[0][0]);
    executorSelection.get.mockResolvedValue({
      decision,
      observations: [],
      hostExecution: null,
    });
    finishBookkeeping();
    await vi.waitFor(() =>
      expect(executorSelection.syncOutcome).toHaveBeenCalled(),
    );
    expect(getWaveEngineState().waves[0]?.phase).toBe("running");
    expect(getWaveEngineState().waves[0]?.steps[0]?.phase).toBe("failed");
    expect(getWaveEngineState().waves[0]?.steps[0]?.reportVerified).toBe(true);
  });

  it("reports a structured native outcome conflict without a false browser storage warning", async () => {
    selectionPlan();
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(getWaveEngineState().waves[0]?.steps[0]?.phase).toBe("spawned"),
    );
    const decision = decisionFor(executorSelection.select.mock.calls[0][0]);
    executorSelection.get.mockResolvedValue({
      decision,
      observations: [],
      hostExecution: null,
    });
    executorSelection.syncOutcome.mockRejectedValueOnce({
      code: "observation_conflict",
      message: "Reported outcome differs from native execution",
    });
    useConductorGraphStore
      .getState()
      .patchNode("child-0", { status: "completed" });
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(noticeTexts().join("\n")).toContain(
        "Reported outcome differs from native execution",
      ),
    );
    expect(noticeTexts().join("\n")).not.toContain("browser");
    expect(noticeTexts().join("\n")).not.toContain("storage quota");
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
    spawnChildrenPerWave();
    const oldPlan = { ...assistant("plan-old", TWO_STEP_PLAN), created: 1_000 };
    const newPlan = { ...assistant("plan-new", TWO_STEP_PLAN), created: 5_000 };
    setTranscript([oldPlan, newPlan]);
    runWaveEngineTick();
    // Both plans are admitted — a conductor may run several waves at once —
    // and each gets its own first worker.
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(2),
    );
    expect(getWaveEngineState().waves).toHaveLength(2);
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

  it("hands a blocked step to the conductor as a digest instead of parking the wave", async () => {
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

    // Not parked where the conductor cannot see it: the wave goes to its
    // digest, and the conductor's verdict decides what comes next.
    expect(getWaveEngineState().waves[0]?.phase).toBe("dispatchingDigest");
    // The satisfied access:"all" successor was never spawned…
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
    // …nothing was stopped…
    expect(stopOrchestratorSession).not.toHaveBeenCalled();
    // …and the operator can read which step blocked and why, in the worker's
    // own words.
    const notice = noticeTexts().at(-1);
    expect(notice).toContain(
      i18n.t("chat:conductor.wave.stepBlocked", { step: 1, name: "child-0" }),
    );
    expect(notice).toContain(
      "the callers file the subtask names does not exist",
    );
    // No step-blocked close: the wave is still the conductor's to judge.
    expect(
      getWaveTelemetry().records.filter(
        (record) => record.closureReason === "step-blocked",
      ),
    ).toEqual([]);
    await vi.waitFor(() =>
      expect(
        queuedTexts().some((text) =>
          text.includes("the callers file the subtask names does not exist"),
        ),
      ).toBe(true),
    );
    // Nothing else was running, so there is no separate early note.
    expect(queuedTexts().some((text) => text.includes("STEP BLOCKED"))).toBe(
      false,
    );

    // Re-ticking neither respawns nor re-announces: the step's persisted
    // flag is the idempotency.
    const noticeCount = noticeTexts().length;
    runWaveEngineTick();
    runWaveEngineTick();
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
    expect(noticeTexts()).toHaveLength(noticeCount);
  });

  it("tells the conductor of a blocked step at once while its siblings keep working", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([
      assistant(
        "plan-1",
        fence(
          '{"steps":[{"role":"integrator","label":"hybrid link","subtask":"Link","access":[]},{"role":"integrator","label":"full v1","subtask":"Decompile","access":[]},{"role":"qa","subtask":"Verify","access":"all"}]}',
        ),
      ),
    ]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(2),
    );
    const step1 = getWaveEngineState().waves[0]?.steps[1];
    const graph = useConductorGraphStore.getState();
    graph.patchNode("child-1", { status: "completed" });
    graph.attachReport({
      runId: step1?.runId ?? "",
      status: "blocked",
      reason: "launch.json names no java PID",
      summary: "Could not find the process",
      decisions: [],
      artifacts: [],
      risks: [],
      needsOperator: true,
      nextSuggestedTask: null,
    });

    runWaveEngineTick();

    // The link step keeps its work: nothing is stopped, the wave runs on.
    expect(stopOrchestratorSession).not.toHaveBeenCalled();
    expect(getWaveEngineState().waves[0]?.phase).toBe("running");
    expect(noticeTexts().at(-1)).toContain(
      i18n.t("chat:conductor.wave.stepBlockedRunning", {
        step: 2,
        name: "child-1",
      }),
    );
    // The conductor hears of it now, with what still runs.
    await vi.waitFor(() =>
      expect(queuedTexts().some((text) => text.includes("STEP BLOCKED"))).toBe(
        true,
      ),
    );
    const note = queuedTexts().find((text) => text.includes("STEP BLOCKED"));
    expect(note).toContain('step 1 "hybrid link"');
    expect(note).toContain("launch.json names no java PID");
    expect(note?.startsWith("[flock-digest:")).toBe(true);

    // Once the link step finishes, the wave completes into its digest and the
    // verifier is never started on top of the gap.
    graph.patchNode("child-0", { status: "completed" });
    graph.attachReport({
      runId: getWaveEngineState().waves[0]?.steps[0]?.runId ?? "",
      status: "completed",
      summary: "Linked",
      decisions: [],
      artifacts: [],
      risks: [],
      needsOperator: false,
      nextSuggestedTask: null,
    });
    runWaveEngineTick();
    expect(getWaveEngineState().waves[0]?.phase).toBe("dispatchingDigest");
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(2);
    expect(
      queuedTexts().filter((text) => text.includes("STEP BLOCKED")),
    ).toHaveLength(1);
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
          '{"steps":[{"role":"scout","subtask":"Look","access":[],"budget":{"minutes":5,"tokens":20000},"class":"algorithms","effort":"high","fast":false}]}',
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
    expect(resolveWaveStepTarget).toHaveBeenCalledWith("scout", "algorithms");
    // The persisted record carries all of them, so a restart resumes the
    // same step.
    expect(getWaveEngineState().waves[0]?.steps[0]).toMatchObject({
      budget: { minutes: 5, tokens: 20000 },
      modelClass: "algorithms",
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
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
      expect(getWaveEngineState().waves[0].steps[0].phase).toBe("spawning");

      await vi.advanceTimersByTimeAsync(WAVE_SPAWN_TIMEOUT_MS + 1);
      expect(getWaveEngineState().waves[0].steps[0].phase).toBe("failed");
      expect(noticeTexts().join("\n")).toContain("did not start");

      // The child that finally materializes is stopped, never adopted: the
      // operator was already told this step died (Q2, no auto-retry).
      resolveSpawn({ sessionId: "late-child", runId: "late-run" });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopOrchestratorSession).toHaveBeenCalledWith(
        "late-child",
        expect.any(String),
      );
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
      expect(stopOrchestratorSession).toHaveBeenCalledWith(
        "late-child",
        expect.any(String),
      ),
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

  it("runs a second wave beside the first, queues a plan past the cap, and starts it when a slot frees", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    spawnChildrenPerWave();
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );

    // Ninety seconds in, the operator adds "also, while you're in there…" and
    // the conductor answers with another plan. It runs beside the first: each
    // wave keeps its own digest and verdict (WAVES, Concurrency).
    setTranscript([...conductorMessages(), assistant("plan-2", TWO_STEP_PLAN)]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(2),
    );
    expect(
      getWaveEngineState().waves.filter((wave) => wave.phase === "running"),
    ).toHaveLength(2);
    expect(hasWaveTombstone(getWaveEngineState(), "plan-2")).toBe(true);

    // Past the cap the plan is admitted into a queue, not dropped: the
    // operator is told where it stands, and nothing of it is spawned yet.
    setTranscript([
      ...conductorMessages(),
      assistant("plan-3", TWO_STEP_PLAN),
      assistant("plan-4", TWO_STEP_PLAN),
    ]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(3),
    );
    const queued = getWaveEngineState().waves.find(
      (wave) => wave.phase === "queued",
    );
    expect(queued?.planMessageId).toBe("plan-4");
    expect(noticeTexts().join("\n")).toContain(
      i18n.t("chat:conductor.wave.queued.body", { position: 1 }),
    );
    for (let index = 0; index < 3; index += 1) runWaveEngineTick();
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(3);

    // A running wave closes; the queued plan takes its slot on the same tick.
    const [first] = getWaveEngineState().waves;
    expect(stopWaveByOperator(CONDUCTOR_ID, first.waveId)).toBe(true);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(4),
    );
    expect(
      getWaveEngineState().waves.find((wave) => wave.planMessageId === "plan-4")
        ?.phase,
    ).toBe("running");
    expect(noticeTexts().join("\n")).toContain(
      i18n.t("chat:conductor.wave.queued.started"),
    );
  });

  it("dispatches nothing until the agents and model inventories have loaded", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    setWaveRoutingInputsReadyForTests(false);
    runWaveEngineTick();
    await Promise.resolve();
    // The plan is admitted and the wave is live; its steps simply wait.
    expect(getWaveEngineState().waves[0]?.phase).toBe("running");
    expect(
      getWaveEngineState().waves[0]?.steps.map((step) => step.phase),
    ).toEqual(["pending", "pending"]);
    expect(spawnConductorChildSession).not.toHaveBeenCalled();

    setWaveRoutingInputsReadyForTests(true);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );
  });

  it("holds a spawn left by the previous process until the inputs have loaded", async () => {
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

    // Restart, with the agent list and the inventories still loading: the
    // step is neither reset nor dispatched against an empty world (that is
    // how a recorded decision came back as an "unknown inventory row").
    resetWaveRunnerForTests();
    resetWaveEngineStateCache();
    spawnConductorChildSession.mockResolvedValue({
      sessionId: "child-0",
      runId: "run-9",
    });
    setWaveRoutingInputsReadyForTests(false);
    runWaveEngineTick();
    await Promise.resolve();
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
    expect(getWaveEngineState().waves[0].steps[0].phase).toBe("spawning");

    setWaveRoutingInputsReadyForTests(true);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(2),
    );
  });

  it("does not advance a wave while the window is closing", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );

    // The close guard has spoken; the host then stops the worker. The wave
    // must not read that as step 1 finishing and start step 2 on the way out.
    markAppClosing();
    useConductorGraphStore
      .getState()
      .patchNode("child-0", { status: "stopped" });
    runWaveEngineTick();
    await Promise.resolve();
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
    expect(getWaveEngineState().waves[0]).toMatchObject({
      phase: "running",
      steps: [{ phase: "spawned" }, { phase: "pending" }],
    });
  });

  it("parks a wave whose only worker was killed before it reported, instead of spawning the next step on a stub", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );

    // The process died with the worker (or the operator stopped it): the
    // startup reconcile leaves it `stopped`, and the graph sync writes the
    // app's stand-in report so the digest has a line for it.
    const graph = useConductorGraphStore.getState();
    graph.patchNode("child-0", { status: "stopped" });
    graph.attachReport({
      runId: "run-1",
      status: "cancelled",
      summary: RUN_FALLBACK_SUMMARIES.cancelled,
      decisions: [],
      artifacts: [],
      risks: [],
      needsOperator: true,
      nextSuggestedTask: null,
      synthesized: true,
    });
    runWaveEngineTick();

    // Parked first, like the blocked path, with the interrupted closure…
    expect(getWaveEngineState().waves[0]).toMatchObject({
      phase: "needsOperator",
      closure: { reason: "wave-interrupted" },
    });
    // …the access:"all" successor was never spawned on a "result unknown"
    // stub, and no digest of nothing went to the conductor…
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
    const last = conductorMessages().at(-1);
    expect(last?.content[0]).toMatchObject({
      type: "systemNotification",
      action: {
        type: "retryWaveDigest",
        waveId: getWaveEngineState().waves[0].waveId,
      },
    });
    const notice = noticeTexts().at(-1);
    expect(notice).toContain(
      i18n.t("chat:conductor.wave.verdict.needsOperatorTitle"),
    );
    expect(notice).toContain(
      i18n.t("chat:conductor.wave.verdict.reason.waveInterrupted"),
    );
    expect(getWaveTelemetry().records[0]).toMatchObject({
      outcome: "needs-operator",
      closureReason: "wave-interrupted",
    });

    // The retry is the operator's: nothing respawns or re-announces by itself.
    const noticeCount = noticeTexts().length;
    runWaveEngineTick();
    runWaveEngineTick();
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
    expect(noticeTexts()).toHaveLength(noticeCount);
  });

  it("names the higher-ranked model a step was moved off, and the window that moved it", async () => {
    setWaveStepTargetIoForTests({
      personas: () => [
        {
          id: "scout",
          displayName: "Scout",
          systemPrompt: "Inspect the sample project.",
          isBuiltin: false,
          writable: true,
          modelRanking: JSON.stringify({
            version: 1,
            entries: [
              { platform: "codex-acp", modelId: "example-one", label: "One" },
              { platform: "claude-acp", modelId: "example-two", label: "Two" },
            ],
          }),
        },
      ],
      providers: () =>
        [
          { id: "codex-acp", label: "Codex" },
          { id: "claude-acp", label: "Claude" },
        ] as never,
      modelsForHarness: (harnessId) =>
        harnessId === "codex-acp"
          ? [{ id: "example-one", name: "One", displayName: "One" }]
          : [{ id: "example-two", name: "Two", displayName: "Two" }],
      rateLimits: () =>
        [
          {
            provider: "codex-acp",
            session: {
              usedPercent: 98,
              windowMinutes: 300,
              resetsAt: null,
              resetDescription: null,
            },
            weekly: null,
            updatedAt: Date.now(),
            error: null,
            status: "ok",
            configured: true,
          },
        ] as never,
      conductorTarget: () => undefined,
    });
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([
      assistant(
        "plan-1",
        fence(
          '{"steps":[{"role":"scout","subtask":"Inspect the sample input","access":[]}]}',
        ),
      ),
    ]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(getWaveEngineState().waves[0]?.steps[0]?.phase).toBe("spawned"),
    );
    expect(spawnConductorChildSession.mock.calls[0][0]).toMatchObject({
      executionTarget: { modelId: "example-two" },
    });
    // Not "its first-choice model was not available": which model, and the
    // number that moved the step off it, against the wave's own threshold.
    expect(noticeTexts()).toEqual([
      i18n.t("chat:conductor.wave.stepModel.skipped", {
        step: 1,
        name: roleDisplayName("scout"),
        model: "Two",
        reasons: i18n.t("chat:conductor.wave.stepModel.skipReason.nearLimit", {
          label: "One",
          percent: 98,
          threshold: 85,
        }),
      }),
    ]);
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
        noticeTexts().some((text) => text.includes("stopped moving")),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a wave alone while a child thinks or waits on a background task", async () => {
    vi.useFakeTimers();
    try {
      useConductorGraphStore.getState().registerNode(conductorNode());
      setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
      runWaveEngineTick();
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);

      // A model at high effort sends nothing for minutes while its turn runs.
      useChatStore.setState({
        sessionStateById: {
          ...useChatStore.getState().sessionStateById,
          "child-0": {
            ...INITIAL_SESSION_CHAT_RUNTIME,
            chatState: "thinking",
          },
        },
      });
      for (let i = 0; i < WAVE_STALL_THRESHOLD * 3; i += 1) {
        await vi.advanceTimersByTimeAsync(WAVE_STALL_SAMPLE_MS + 200);
      }
      expect(getWaveEngineState().waves[0]?.stalled).toBeFalsy();
      expect(getWaveEngineState().waves[0]?.phase).toBe("running");

      // Its turn ends with a build still running in the background.
      useChatStore.setState({
        sessionStateById: {
          ...useChatStore.getState().sessionStateById,
          "child-0": { ...INITIAL_SESSION_CHAT_RUNTIME },
        },
      });
      useBackgroundTasksStore
        .getState()
        .replace("child-0", [{ id: "build", state: "running" }]);
      for (let i = 0; i < WAVE_STALL_THRESHOLD * 3; i += 1) {
        await vi.advanceTimersByTimeAsync(WAVE_STALL_SAMPLE_MS + 200);
      }
      expect(getWaveEngineState().waves[0]?.stalled).toBeFalsy();
      expect(stopOrchestratorSession).not.toHaveBeenCalled();
    } finally {
      useBackgroundTasksStore.getState().replace("child-0", []);
      vi.useRealTimers();
    }
  });
});
