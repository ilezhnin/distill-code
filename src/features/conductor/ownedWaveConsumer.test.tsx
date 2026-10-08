import { renderHook, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  OwnedTaskRequest,
  PreparedOwnedTask,
  OwnedTaskDispatch,
} from "@/features/benchmarks/lib/ownedTaskExecution";
import type { AcpSessionInfo } from "@/shared/api/acpApi";
import { i18n } from "@/shared/i18n";
import { useConductorGraphSync } from "./useConductorGraphSync";
import { spawnConductorChildSession } from "./spawnOrchestrator";
import {
  closeUnstartedWaveExecutor,
  resetWaveExecutorOutcomesForTests,
  syncWaveExecutorOutcomes,
} from "./waveExecutor";
import { useConductorGraphStore } from "./conductorGraphStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { resetWaveEngineStateCache, getWaveEngineState } from "./waveStore";
import {
  taskBindingId,
  isProtectedExecutionSession,
  observeExecutionOwner,
} from "@/features/chat/lib/executionOwnership";

const io = vi.hoisted(() => ({
  prepared: new Map<string, PreparedOwnedTask>(),
  statuses: new Map<string, OwnedTaskDispatch>(),
  prepare: vi.fn(),
  get: vi.fn(),
  status: vi.fn(),
  publicResult: vi.fn(),
  choices: vi.fn(),
  ordinary: vi.fn(),
  digest: vi.fn(),
  observe: vi.fn(async (key: string) => {
    if (key.startsWith("owned-task:"))
      throw new Error("Native task journal cannot be supplied by the renderer");
  }),
  syncOutcome: vi.fn<
    (
      key: string,
      session: string,
      runId: string,
      outcome: string,
    ) => Promise<void>
  >(async () => undefined),
}));
vi.mock("@/features/chat/stores/chatSessionOperations", () => ({
  updateSessionTitle: vi.fn(async () => undefined),
}));
vi.mock("./digestDelivery", () => ({
  deliverEnvelope: io.digest,
  classifyDigestDispatchError: () => ({ status: "failed" }),
}));
vi.mock("@/features/benchmarks/api/benchmarkGovernance", () => ({
  benchmarkGovernanceApi: {
    listPromotions: vi.fn(async () => [
      {
        revokedAt: null,
        certificate: {
          id: "qualified",
          artifactHash: "certificate",
          contract: { roleId: "qa" },
        },
      },
    ]),
  },
}));
vi.mock("@/features/benchmarks/lib/ownedTaskExecution", async (original) => ({
  ...(await original<
    typeof import("@/features/benchmarks/lib/ownedTaskExecution")
  >()),
  ownedTaskExecution: {
    getMode: vi.fn(async () => ({
      request: {
        contextId: "owned-conductor",
        promotionId: "qualified",
        acknowledgedCertificateHash: "certificate",
        repository: null,
      },
      artifactHash: "native-consent",
    })),
    prepare: io.prepare,
    get: io.get,
    status: io.status,
    publicResult: io.publicResult,
    choices: io.choices,
    cancel: vi.fn(async () => undefined),
    dispatch: vi.fn(async (id: string) => io.statuses.get(id)),
  },
}));
vi.mock("@/features/benchmarks/lib/executorSelection", () => ({
  executorSelection: {
    get: vi.fn(async (key: string) => {
      const prepared = [...io.prepared.values()].find(
        (row) => row.binding.request.requestKey === key,
      );
      if (!prepared) return null;
      const dispatch = io.statuses.get(prepared.binding.id);
      return {
        decision: prepared.binding.decision,
        observations: [],
        hostExecution: {
          start: {
            link: { decisionKey: key, logicalRunId: key },
            sessionId: prepared.session.owned.sessionId,
            hostRunId: dispatch?.runId,
            messageId: dispatch?.userMessageId,
            bridgeGeneration: 1,
            providerId: "claude-acp",
            accountId: "invented-account",
            startedAt: "1970-01-01T00:00:00.002Z",
            selection: {
              modelId: prepared.session.observed.modelId,
              modelName: null,
              effort: "high",
              fast: false,
            },
          },
          finish:
            dispatch?.phase === "terminal"
              ? {
                  finishedAt: "1970-01-01T00:00:00.003Z",
                  status: dispatch.error
                    ? dispatch.error.kind === "cancelled"
                      ? "cancelled"
                      : "failed"
                    : "completed",
                  selection: {
                    modelId: prepared.session.observed.modelId,
                    modelName: null,
                    effort: "high",
                    fast: false,
                  },
                  changes: [],
                  changesTruncated: false,
                }
              : null,
        },
      };
    }),
    observe: io.observe,
    syncOutcome: io.syncOutcome,
  },
}));
vi.mock("@/shared/api/acpApi", async (original) => ({
  ...(await original<typeof import("@/shared/api/acpApi")>()),
  readSessionTranscript: vi.fn(async (sessionId: string) => {
    const dispatch = [...io.statuses.values()].find(
      (row) => row.sessionId === sessionId,
    );
    if (!dispatch) throw new Error("Unknown invented native task history");
    return {
      messages: [
        {
          id: dispatch.userMessageId,
          role: "user",
          created: "1970-01-01T00:00:00.001Z",
          content: [{ type: "text", text: "Frozen native fixture request" }],
        },
      ],
    };
  }),
}));
vi.mock("@/shared/api/acp", async (original) => ({
  ...(await original<typeof import("@/shared/api/acp")>()),
  acpSendMessage: io.ordinary,
  acpGetSessionInfo: vi.fn(async (id: string) => {
    const prepared = [...io.prepared.values()].find(
      (row) => row.session.owned.sessionId === id,
    );
    if (!prepared) throw new Error("Unknown invented task session");
    return {
      sessionId: id,
      executionOwner: { kind: "task", id: prepared.session.owned.ownerId },
      providerId: "claude-acp",
      accountId: "invented-account",
      modelId: prepared.session.observed.modelId,
      reasoningEffort: "high",
      fastMode: false,
      workingDir: "C:/invented-owned-workspace",
      title: "Invented native task",
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      messageCount: 0,
      archivedAt: null,
    } as AcpSessionInfo;
  }),
}));
function report(value: string) {
  return `\`\`\`distill-report\n${JSON.stringify({ status: "completed", summary: value, decisions: [], artifacts: [{ label: "Invented plumbing evidence", path: "invented-evidence.txt" }], risks: [], needsOperator: false, nextSuggestedTask: null })}\n\`\`\``;
}

function makePreparedOwnedTask(
  request: OwnedTaskRequest,
  id: string,
): PreparedOwnedTask {
  const configuration = {
    id: "native-choice",
    providerId: "claude-acp",
    accountId: "invented-account",
    modelId: request.prompt.includes("parser")
      ? "invented-parser"
      : "invented-painter",
    modelName: null,
    effort: "high",
    fastMode: false,
    billingMode: "simulated",
    executionProfile: "native_text",
    inventoryRevision: "invented-fixture-revision",
  };
  const task = {
    prompt: request.prompt,
    workClassId: "debug",
    roleId: "qa",
    rolePrompt: "Frozen native role",
    fixtures: [],
    facets: {},
    permissions: { tools: [], network: false, context: "clean" },
    executionProfile: "native_text",
    limits: { timeoutSeconds: 10, maxTurns: 1, maxArtifactBytes: 1024 },
    entry: {
      conversationPrefix: "",
      previousReports: request.entry ? [report("Native parser result")] : [],
      remainingBudgetSeconds: 10,
    },
  };
  const key = `owned-task:${id}`;
  const prepared: PreparedOwnedTask = {
    binding: {
      id,
      request: { ...request, requestKey: key },
      task,
      certificateHash: "certificate",
      contextHash: `native-context-${id}`,
      artifactHash: "binding-hash",
      createdAt: 1,
      decision: {
        request: {
          requestKey: key,
          surface: "wave",
          contextId: request.contextId,
          prediction: {
            task,
            targetFamily: "invented",
            targetGroup: "invented",
            candidates: [{ configuration, available: true, reason: null }],
            hardCandidateKey: null,
            minQuality: 0,
          },
          priorKeys: [],
          modelId: null,
        },
        source: "learned",
        learnedDispatchAllowed: true,
        chosen: configuration,
        chosenKey: "native-choice",
        reason: "qualified-native-fixture",
        createdAt: 1,
        inputHash: "input",
        artifactHash: "decision",
        policyVersion: "native-owned",
        learnedStatus: "authorized_owned_scope",
        researchPrediction: null,
      },
    },
    session: {
      observed: configuration,
      contextHash: `native-context-${id}`,
      owned: {
        sessionId: `native-${id}`,
        ownerId: `task:${id}`,
        policyHash: "native-policy",
        selection: {
          modelId: configuration.modelId,
          reasoningEffort: "high",
          fastMode: false,
        },
        substitutions: [],
      },
    },
  };
  return prepared;
}

afterEach(() => vi.useRealTimers());

function restoreNativeChild(id: string) {
  const parent = `parent-${id}`;
  const waveId = `wave-${id}`;
  const prepared = makePreparedOwnedTask(
    {
      requestKey: id,
      surface: "wave",
      contextId: `${parent}:wave:${waveId}`,
      promotionId: "qualified",
      acknowledgedCertificateHash: "certificate",
      prompt: "Inspect invented task",
      hardCandidateKey: null,
      repository: null,
      entry: null,
      waveMode: { contextId: parent, artifactHash: "native-consent" },
    },
    id,
  );
  const status: OwnedTaskDispatch = {
    requestKey: prepared.binding.request.requestKey,
    sessionId: prepared.session.owned.sessionId,
    runId: `host-${id}`,
    userMessageId: `user-${id}`,
    phase: "running",
    eventCursor: 1,
    result: null,
    error: null,
  };
  io.prepared.set(id, prepared);
  io.statuses.set(id, status);
  io.get.mockImplementation(async (binding: string) =>
    io.prepared.get(binding),
  );
  io.status.mockImplementation(async (binding: string) =>
    io.statuses.get(binding),
  );
  observeExecutionOwner(status.sessionId, {
    kind: "task",
    id: prepared.session.owned.ownerId,
  });
  useChatSessionStore.setState({
    sessions: [
      {
        id: parent,
        title: "Invented conductor",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 0,
        workingDir: "C:/invented-source",
        executionTarget: { harnessId: "claude-acp" },
      },
    ],
    hasHydratedSessions: true,
  });
  useChatStore.setState({
    hasHydratedMessageQueues: true,
    messagesBySession: {},
    sessionStateById: {},
  });
  useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
  useConductorGraphStore.getState().registerNode({
    sessionId: parent,
    projectId: "invented-project",
    role: "conductor",
    managedBy: "ui",
    parentSessionId: null,
    rootConductorId: parent,
    runId: null,
    displayName: "Invented conductor",
    status: "stopped",
    harnessId: "claude-acp",
  });
  return { prepared, status, parent, waveId };
}

it("restored registered native child reconciles a later sealed terminal result without renderer store events", async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetWaveEngineStateCache();
  io.prepared.clear();
  io.statuses.clear();
  const { prepared, status, parent, waveId } = restoreNativeChild("restored");
  const graph = useConductorGraphStore.getState();
  graph.registerNode({
    sessionId: status.sessionId,
    projectId: "invented-project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: parent,
    rootConductorId: parent,
    runId: status.requestKey,
    displayName: "Restored native task",
    status: "running",
    harnessId: "claude-acp",
    waveId,
    stepIndex: 0,
  });
  io.publicResult
    .mockReset()
    .mockRejectedValueOnce(new Error("Temporary native result read failure"))
    .mockResolvedValue({
      text: JSON.stringify({
        outcome: "completed",
        output: report("Restored native result"),
      }),
      elapsedMs: 10,
    });
  const hook = renderHook(() => useConductorGraphSync());
  expect(graph.getNode(status.sessionId)?.status).toBe("running");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(io.status).toHaveBeenCalledWith(prepared.binding.id);
  // Only the simulated native DB changes. There is no local send promise,
  // transcript update or store notification after the earlier running read.
  io.statuses.set(prepared.binding.id, { ...status, phase: "terminal" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(graph.getReport(status.requestKey)).toBeUndefined();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(graph.getNode(status.sessionId)?.status).toBe("completed");
  expect(graph.getReport(status.requestKey)?.summary).toBe(
    "Restored native result",
  );
  expect(io.prepare).not.toHaveBeenCalled();
  expect(io.ordinary).not.toHaveBeenCalled();
  hook.unmount();
});

it("owned wave attribution uses completed native receipt instead of a stale cancelled graph", async () => {
  resetWaveExecutorOutcomesForTests();
  io.prepared.clear();
  io.statuses.clear();
  io.syncOutcome
    .mockReset()
    .mockImplementation(async (_key, _session, _run, outcome) => {
      if (outcome !== "completed")
        throw {
          code: "observation_conflict",
          message: "Reported task outcome differs from the native dispatch",
        };
    });
  const { status, prepared, parent, waveId } =
    restoreNativeChild("outcome-race");
  io.statuses.set(prepared.binding.id, { ...status, phase: "terminal" });
  const graph = useConductorGraphStore.getState();
  graph.registerNode({
    sessionId: status.sessionId,
    projectId: "invented-project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: parent,
    rootConductorId: parent,
    runId: status.requestKey,
    displayName: "Completed native child",
    status: "cancelled",
    harnessId: "claude-acp",
    waveId,
    stepIndex: 0,
  });
  const onError = vi.fn();
  syncWaveExecutorOutcomes(
    Object.values(useConductorGraphStore.getState().nodesById),
    onError,
  );
  await vi.waitFor(() =>
    expect(io.syncOutcome).toHaveBeenCalledWith(
      status.requestKey,
      status.sessionId,
      status.requestKey,
      "completed",
    ),
  );
  await Promise.resolve();
  syncWaveExecutorOutcomes(
    Object.values(useConductorGraphStore.getState().nodesById),
    onError,
  );
  expect(io.syncOutcome).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
  expect(io.prepare).not.toHaveBeenCalled();
  expect(io.ordinary).not.toHaveBeenCalled();
  io.syncOutcome.mockReset().mockResolvedValue(undefined);
});

it("actual owned spawn and native terminal graph sync advance two sequential steps with native entry references", async () => {
  localStorage.clear();
  resetWaveEngineStateCache();
  io.prepared.clear();
  io.statuses.clear();
  io.observe.mockClear();
  io.digest.mockResolvedValue({ status: "dispatched" });
  io.choices.mockResolvedValue([
    {
      candidateKey: "native-painter-high",
      available: true,
      reason: null,
      configuration: {
        id: "native-choice",
        providerId: "claude-acp",
        accountId: "invented-account",
        modelId: "invented-painter",
        modelName: null,
        effort: "high",
        fastMode: false,
        billingMode: "simulated",
        executionProfile: "native_text",
        inventoryRevision: "invented-fixture-revision",
      },
    },
  ]);
  io.prepare.mockImplementation(async (request: OwnedTaskRequest) => {
    const id = `binding-${io.prepared.size}`;
    const prepared = makePreparedOwnedTask(request, id);
    io.prepared.set(id, prepared);
    io.statuses.set(id, {
      requestKey: prepared.binding.request.requestKey,
      sessionId: prepared.session.owned.sessionId,
      runId: `host-${id}`,
      userMessageId: `user-${id}`,
      phase: "running",
      eventCursor: 1,
      result: null,
      error: null,
    });
    return prepared;
  });
  io.get.mockImplementation(async (id: string) => io.prepared.get(id));
  io.status.mockImplementation(async (id: string) => io.statuses.get(id));
  io.publicResult.mockImplementation(async (id: string) => ({
    text: JSON.stringify({
      outcome: "completed",
      output: report(
        id === "binding-0" ? "Native parser result" : "Native painter result",
      ),
    }),
    elapsedMs: 8,
  }));
  useChatSessionStore.setState({
    sessions: [
      {
        id: "owned-conductor",
        title: "Invented conductor",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 1,
        workingDir: "C:/invented-source",
        executionTarget: { harnessId: "claude-acp" },
      },
    ],
    hasHydratedSessions: true,
  });
  useChatStore.setState({
    hasHydratedMessageQueues: true,
    messagesBySession: {
      "owned-conductor": [
        {
          id: "plan",
          role: "assistant",
          created: 1,
          metadata: { completionStatus: "completed" },
          content: [
            {
              type: "text",
              text: '```distill-wave\n{"steps":[{"role":"qa","subtask":"Inspect parser evidence","access":[]},{"role":"qa","subtask":"Inspect painter evidence","access":"all","effort":"high","fast":false}]}\n```',
            },
          ],
        },
      ],
    },
    sessionStateById: {},
  });
  useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
  useConductorGraphStore.getState().registerNode({
    sessionId: "owned-conductor",
    projectId: "invented-project",
    role: "conductor",
    managedBy: "ui",
    parentSessionId: null,
    rootConductorId: "owned-conductor",
    runId: null,
    displayName: "Invented conductor",
    status: "stopped",
    harnessId: "claude-acp",
  });
  const hook = renderHook(() => useConductorGraphSync());
  await vi.waitFor(() => expect(io.prepare).toHaveBeenCalledTimes(1));
  await vi.waitFor(() =>
    expect(getWaveEngineState().waves[0]?.steps[0].phase).toBe("spawned"),
  );
  const first = io.prepared.get("binding-0");
  const firstStatus = io.statuses.get("binding-0");
  if (!first || !firstStatus)
    throw new Error("First native task was not prepared");
  expect(taskBindingId(first.session.owned.sessionId)).toBe("binding-0");
  expect(isProtectedExecutionSession(first.session.owned.sessionId)).toBe(true);
  await act(async () => {
    io.statuses.set("binding-0", {
      ...firstStatus,
      phase: "terminal",
    });
    useChatStore.getState().setChatState(first.session.owned.sessionId, "idle");
  });
  await vi.waitFor(() => expect(io.prepare).toHaveBeenCalledTimes(2));
  expect(io.prepare.mock.calls[1][0].entry).toEqual({
    rootBindingId: "binding-0",
    previousBindingIds: ["binding-0"],
    includePreviousOutput: true,
  });
  expect(io.prepare.mock.calls[1][0].prompt).toBe("Inspect painter evidence");
  expect(io.prepare.mock.calls[1][0].hardCandidateKey).toBe(
    "native-painter-high",
  );
  expect(
    useConductorGraphStore
      .getState()
      .getReport(first.binding.request.requestKey)?.summary,
  ).toBe("Native parser result");
  expect(io.ordinary).not.toHaveBeenCalled();
  expect(io.observe).not.toHaveBeenCalled();
  const second = io.prepared.get("binding-1");
  const secondStatus = io.statuses.get("binding-1");
  if (!second || !secondStatus)
    throw new Error("Second native task was not prepared");
  await vi.waitFor(() =>
    expect(getWaveEngineState().waves[0]?.steps[1].phase).toBe("spawned"),
  );
  await act(async () => {
    io.statuses.set("binding-1", {
      ...secondStatus,
      phase: "terminal",
    });
    useChatStore
      .getState()
      .setChatState(second.session.owned.sessionId, "idle");
  });
  await vi.waitFor(() => expect(io.digest).toHaveBeenCalledOnce());
  expect(
    useConductorGraphStore.getState().getNode(second.session.owned.sessionId)
      ?.status,
  ).toBe("completed");
  expect(io.observe).not.toHaveBeenCalled();
  const notices = useChatStore
    .getState()
    .messagesBySession["owned-conductor"].flatMap((message) =>
      message.content
        .filter((part) => part.type === "systemNotification")
        .map((part) => part.text),
    );
  expect(
    notices.some((text) =>
      text.includes(i18n.t("chat:conductor.persist.title")),
    ),
  ).toBe(false);
  hook.unmount();
});

it("unstarted owned cleanup leaves journal authority native and preserves ordinary prior observations", async () => {
  io.observe.mockClear();
  await closeUnstartedWaveExecutor(
    "owned-task:never-processed",
    "failed",
    "Native setup refused",
  );
  expect(io.observe).not.toHaveBeenCalled();
  await closeUnstartedWaveExecutor(
    "ordinary-wave-key",
    "failed",
    "Ordinary setup refused",
  );
  expect(io.observe).toHaveBeenCalledWith(
    "ordinary-wave-key",
    expect.objectContaining({
      phase: "terminal",
      outcome: "failed",
      configuration: null,
    }),
  );
});

it("a post-processing send rejection cannot overwrite the native cancelled wave child", async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetWaveEngineStateCache();
  io.prepared.clear();
  io.statuses.clear();
  const { prepared, status, parent, waveId } = restoreNativeChild("cancelled");
  let finishAccounting!: () => void;
  const accountingGate = new Promise<void>((resolve) => {
    finishAccounting = resolve;
  });
  io.syncOutcome.mockImplementation(async (key: string) => {
    if (key === status.requestKey) await accountingGate;
  });
  const hook = renderHook(() => useConductorGraphSync());
  const child = await spawnConductorChildSession({
    parentSessionId: parent,
    role: "worker",
    task: prepared.binding.task.prompt,
    ownedTask: prepared,
    managedBy: "wave",
    waveId,
    stepIndex: 0,
    roleId: "qa",
  });
  expect(child.runId).toBe(status.requestKey);
  io.statuses.set(prepared.binding.id, {
    ...status,
    phase: "terminal",
    error: { kind: "cancelled", message: "Native cancellation confirmed" },
  });
  await act(async () => {
    useChatStore.getState().setChatState(status.sessionId, "idle");
    await vi.advanceTimersByTimeAsync(200);
  });
  const graph = useConductorGraphStore.getState();
  // A running native read may still be in flight when cancellation arrives.
  // Drive the existing authoritative poll while accounting remains blocked.
  await act(async () => {
    await vi.waitFor(
      () => {
        expect(graph.getNode(status.sessionId)?.status).toBe("cancelled");
      },
      { timeout: 2000 },
    );
  });
  expect(graph.getNode(status.sessionId)?.status).toBe("cancelled");
  expect(graph.getReport(status.requestKey)?.status).toBe("cancelled");
  expect(io.syncOutcome).toHaveBeenCalledWith(
    status.requestKey,
    status.sessionId,
    status.requestKey,
    "cancelled",
  );
  await act(async () => {
    finishAccounting();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(graph.getNode(status.sessionId)?.status).toBe("cancelled");
  expect(useChatStore.getState().sessionStateById[status.sessionId].error).toBe(
    "Native cancellation confirmed",
  );
  expect(io.ordinary).not.toHaveBeenCalled();
  hook.unmount();
});
