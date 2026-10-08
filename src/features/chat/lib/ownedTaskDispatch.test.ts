import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { dispatchPrompt } from "./sendCore";
import { reconcileOwnedTaskSession } from "./ownedTaskDispatch";
import { useChatStore } from "../stores/chatStore";
import { useChatSessionStore } from "../stores/chatSessionStore";
import type {
  PreparedOwnedTask,
  OwnedTaskDispatch,
} from "@/features/benchmarks/lib/ownedTaskExecution";
import type {
  ExecutorDecisionRecord,
  ExecutorHostReceipt,
} from "@/features/benchmarks/lib/executorSelection";
import {
  observeExecutionOwner,
  isProtectedExecutionSession,
  taskBindingId,
} from "./executionOwnership";

const io = vi.hoisted(() => ({
  get: vi.fn(),
  dispatch: vi.fn(),
  status: vi.fn(),
  cancel: vi.fn(),
  receipt: vi.fn(),
  sync: vi.fn(),
  ordinary: vi.fn(),
  transcript: vi.fn(),
}));
vi.mock("@/shared/api/acpApi", async (original) => ({
  ...(await original<typeof import("@/shared/api/acpApi")>()),
  readSessionTranscript: io.transcript,
}));
vi.mock("@/features/benchmarks/lib/ownedTaskExecution", () => ({
  ownedTaskExecution: {
    get: io.get,
    dispatch: io.dispatch,
    status: io.status,
    cancel: io.cancel,
  },
}));
vi.mock("@/features/benchmarks/lib/executorSelection", () => ({
  executorSelection: { get: io.receipt, syncOutcome: io.sync },
}));
vi.mock("@/shared/api/acp", async (original) => ({
  ...(await original<typeof import("@/shared/api/acp")>()),
  acpSendMessage: io.ordinary,
}));

const configuration = {
  id: "invented-worker",
  providerId: "invented-provider",
  accountId: "invented-account",
  modelId: "invented-model",
  modelName: null,
  effort: "high",
  fastMode: false,
  billingMode: "simulated",
  executionProfile: "native_text",
  inventoryRevision: "invented-runtime",
};
const task = {
  workClassId: "debug",
  prompt: "Invented public task",
  fixtures: [],
  facets: {},
  roleId: "writer",
  rolePrompt: "Frozen role",
  permissions: { tools: [], network: false, context: "clean" },
  executionProfile: "native_text",
  limits: { timeoutSeconds: 10, maxTurns: 1, maxArtifactBytes: 1024 },
  entry: {
    conversationPrefix: "",
    previousReports: [],
    remainingBudgetSeconds: 10,
  },
};
const prepared: PreparedOwnedTask = {
  binding: {
    id: "binding",
    createdAt: 1,
    request: {
      requestKey: "owned-task:example",
      surface: "chat",
      contextId: "fresh",
      promotionId: "qualified",
      acknowledgedCertificateHash: "certificate",
      prompt: task.prompt,
      hardCandidateKey: null,
      repository: null,
      entry: null,
      waveMode: null,
    },
    certificateHash: "certificate",
    task,
    contextHash: "context",
    artifactHash: "binding-hash",
    decision: {
      request: {
        requestKey: "owned-task:example",
        surface: "chat",
        contextId: "fresh",
        prediction: {
          task,
          targetFamily: "fresh",
          targetGroup: "fresh",
          candidates: [{ configuration, available: true, reason: null }],
          hardCandidateKey: null,
          minQuality: 0,
        },
        priorKeys: [],
        modelId: null,
      },
      chosen: configuration,
      chosenKey: "native-key",
      source: "learned",
      reason: "qualified_preregistered_native_owned_policy",
      createdAt: 1,
      inputHash: "input",
      artifactHash: "decision",
      policyVersion: "native-owned",
      learnedStatus: "authorized_owned_scope",
      researchPrediction: null,
      learnedDispatchAllowed: true,
    },
  },
  session: {
    owned: {
      sessionId: "owned-session",
      ownerId: "task:binding",
      policyHash: "policy",
      selection: {
        modelId: "invented-model",
        reasoningEffort: "high",
        fastMode: false,
      },
      substitutions: [],
    },
    observed: configuration,
    contextHash: "context",
  },
};
const status = (
  phase: OwnedTaskDispatch["phase"],
  error: OwnedTaskDispatch["error"] = null,
): OwnedTaskDispatch => ({
  requestKey: "owned-task:example",
  sessionId: "owned-session",
  runId: "host-run",
  userMessageId: "host-user",
  phase,
  eventCursor: 1,
  result: null,
  error,
});
const receipt: ExecutorHostReceipt = {
  start: {
    link: {
      decisionKey: "owned-task:example",
      logicalRunId: "owned-task:example",
    },
    sessionId: "owned-session",
    hostRunId: "host-run",
    messageId: "host-user",
    bridgeGeneration: 1,
    providerId: "invented-provider",
    accountId: "invented-account",
    startedAt: "2026-01-01T00:00:00Z",
    selection: {
      modelId: "invented-model",
      modelName: null,
      effort: "high",
      fast: false,
    },
  },
  finish: {
    finishedAt: "2026-01-01T00:00:01Z",
    status: "completed",
    selection: {
      modelId: "invented-model",
      modelName: null,
      effort: "high",
      fast: false,
    },
    changes: [],
    changesTruncated: false,
  },
};
const record = (
  hostExecution: ExecutorHostReceipt | null,
): ExecutorDecisionRecord => ({
  decision: prepared.binding.decision,
  hostExecution,
  observations: [],
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useChatStore.setState({ messagesBySession: {}, sessionStateById: {} });
  useChatSessionStore.setState({ sessions: [] });
  io.get.mockResolvedValue(prepared);
  io.receipt.mockResolvedValue(record(null));
  io.cancel.mockResolvedValue(undefined);
  io.sync.mockResolvedValue(undefined);
  io.transcript.mockResolvedValue({
    messages: [
      {
        id: "host-user",
        role: "user",
        created: "1970-01-01T00:00:01.000Z",
        content: [
          { type: "text", text: "Frozen native context\nInvented public task" },
        ],
      },
      {
        id: "host-assistant",
        role: "assistant",
        created: "1970-01-01T00:00:02.000Z",
        content: [{ type: "text", text: "Native final reply" }],
      },
    ],
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
});
it("both surfaces use the actual owned consumer and commit only after the native processing receipt", async () => {
  io.dispatch.mockResolvedValue(status("reserved"));
  io.status.mockResolvedValue(status("terminal"));
  const committed = vi.fn();
  const dispatched = vi.fn();
  const send = dispatchPrompt("owned-session", task.prompt, {
    ownedTaskBindingId: "binding",
    onUserMessageCommitted: committed,
    onPromptDispatched: dispatched,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(committed).not.toHaveBeenCalled();
  expect(dispatched).not.toHaveBeenCalled();
  io.receipt.mockResolvedValue(record(receipt));
  await vi.advanceTimersByTimeAsync(100);
  await send;
  expect(committed).toHaveBeenCalledOnce();
  expect(dispatched).toHaveBeenCalledOnce();
  expect(useChatStore.getState().messagesBySession["owned-session"][0].id).toBe(
    "host-user",
  );
  expect(io.ordinary).not.toHaveBeenCalled();
  expect(io.sync).toHaveBeenCalledWith(
    "owned-task:example",
    "owned-session",
    "owned-task:example",
    "completed",
  );
});
it("preclaim refusal retains the first-message lease and adds no accepted user turn", async () => {
  io.dispatch.mockResolvedValue(
    status("terminal", {
      kind: "revoked",
      message: "Authority revoked before processing",
    }),
  );
  const committed = vi.fn();
  await expect(
    dispatchPrompt("owned-session", task.prompt, {
      ownedTaskBindingId: "binding",
      onUserMessageCommitted: committed,
    }),
  ).rejects.toThrow("Authority revoked");
  expect(committed).not.toHaveBeenCalled();
  expect(
    useChatStore.getState().messagesBySession["owned-session"] ?? [],
  ).toHaveLength(0);
  expect(io.sync).not.toHaveBeenCalled();
});
it("delayed processing acknowledgement preserves an already hydrated native user turn exactly once", async () => {
  io.dispatch.mockResolvedValue(status("reserved"));
  io.status.mockResolvedValue(status("terminal"));
  const committed = vi.fn();
  const send = dispatchPrompt("owned-session", task.prompt, {
    ownedTaskBindingId: "binding",
    onUserMessageCommitted: committed,
  });
  await vi.advanceTimersByTimeAsync(0);
  useChatStore.getState().addMessage("owned-session", {
    id: "host-user",
    role: "user",
    created: 1,
    content: [{ type: "text", text: task.prompt }],
  });
  io.receipt.mockResolvedValue(record(receipt));
  await vi.advanceTimersByTimeAsync(100);
  await send;
  expect(
    useChatStore
      .getState()
      .messagesBySession["owned-session"].filter(
        (message) => message.id === "host-user",
      ),
  ).toHaveLength(1);
  expect(committed).toHaveBeenCalledOnce();
  expect(io.dispatch).toHaveBeenCalledOnce();
  expect(io.ordinary).not.toHaveBeenCalled();
});
it("unknown dispatch stays visible and never routes to ordinary ACP or automatically resends", async () => {
  io.dispatch.mockResolvedValue(status("uncertain"));
  await expect(
    dispatchPrompt("owned-session", task.prompt, {
      ownedTaskBindingId: "binding",
    }),
  ).rejects.toThrow("unknown");
  expect(io.dispatch).toHaveBeenCalledOnce();
  expect(io.ordinary).not.toHaveBeenCalled();
  expect(
    useChatStore.getState().sessionStateById["owned-session"]
      .isRunCancellationPending,
  ).toBe(true);
});
it("abort before processing cancels natively and preserves the unaccepted first message", async () => {
  const abort = new AbortController();
  io.dispatch.mockResolvedValue(status("reserved"));
  io.status.mockResolvedValue(
    status("terminal", {
      kind: "cancelled",
      message: "Cancelled before processing",
    }),
  );
  const committed = vi.fn();
  const send = dispatchPrompt("owned-session", task.prompt, {
    ownedTaskBindingId: "binding",
    signal: abort.signal,
    onUserMessageCommitted: committed,
  });
  const rejected = expect(send).rejects.toThrow("Cancelled before processing");
  await vi.advanceTimersByTimeAsync(0);
  abort.abort();
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
  expect(io.cancel).toHaveBeenCalledWith("binding");
  expect(committed).not.toHaveBeenCalled();
  expect(io.dispatch).toHaveBeenCalledOnce();
});
it("task purpose replay remains visible while memory and autonomous wave scanners remain excluded", () => {
  observeExecutionOwner("owned-session", {
    kind: "benchmark",
    id: "task:binding",
  });
  observeExecutionOwner("owned-session", { kind: "task", id: "task:binding" });
  expect(taskBindingId("owned-session")).toBe("binding");
  expect(isProtectedExecutionSession("owned-session")).toBe(true);
});

function seedOwnedReply() {
  observeExecutionOwner("owned-session", { kind: "task", id: "task:binding" });
  useChatStore.getState().setMessages("owned-session", [
    {
      id: "host-assistant",
      role: "assistant",
      created: 9000,
      content: [{ type: "text", text: "Keep live reply" }],
      metadata: { completionStatus: "inProgress" },
    },
  ]);
  useChatStore
    .getState()
    .setStreamingMessageId("owned-session", "host-assistant");
  useChatStore.getState().setActiveRunId("owned-session", "host-run");
  io.status.mockResolvedValue(status("terminal"));
  io.receipt.mockResolvedValue(record(receipt));
}

it("orders a delayed ACK user before an already streamed assistant using persisted history time and completes the live reply", async () => {
  io.dispatch.mockResolvedValue(status("reserved"));
  io.status.mockResolvedValue(status("terminal"));
  const send = dispatchPrompt("owned-session", task.prompt, {
    ownedTaskBindingId: "binding",
  });
  await vi.advanceTimersByTimeAsync(0);
  useChatStore.getState().addMessage("owned-session", {
    id: "host-assistant",
    role: "assistant",
    created: 9000,
    content: [{ type: "text", text: "Keep live reply" }],
    metadata: { completionStatus: "inProgress" },
  });
  io.receipt.mockResolvedValue(record(receipt));
  await vi.advanceTimersByTimeAsync(100);
  await send;
  const messages = useChatStore.getState().messagesBySession["owned-session"];
  expect(messages.map(({ id, created }) => ({ id, created }))).toEqual([
    { id: "host-user", created: 1000 },
    { id: "host-assistant", created: 2000 },
  ]);
  expect(messages[0].content).toEqual([{ type: "text", text: task.prompt }]);
  expect(messages[1]).toMatchObject({
    content: [{ type: "text", text: "Keep live reply" }],
    metadata: { completionStatus: "completed" },
  });
  expect(io.dispatch).toHaveBeenCalledOnce();
});

it("recovers a reloaded terminal task without dispatch and reuses a stable canonical projection on repeated reads", async () => {
  seedOwnedReply();
  await expect(reconcileOwnedTaskSession("owned-session")).resolves.toBe(true);
  const first = useChatStore.getState().messagesBySession["owned-session"];
  expect(first.map((message) => message.id)).toEqual([
    "host-user",
    "host-assistant",
  ]);
  expect(first[1].metadata?.completionStatus).toBe("completed");
  expect(
    useChatStore.getState().getSessionRuntime("owned-session"),
  ).toMatchObject({
    chatState: "idle",
    activeRunId: null,
    streamingMessageId: null,
    isRunCancellationPending: false,
  });
  await expect(reconcileOwnedTaskSession("owned-session")).resolves.toBe(true);
  expect(io.transcript).toHaveBeenCalledOnce();
  expect(useChatStore.getState().messagesBySession["owned-session"]).toBe(
    first,
  );
  expect(
    io.sync.mock.calls.every(
      (args) =>
        JSON.stringify(args) ===
        JSON.stringify([
          "owned-task:example",
          "owned-session",
          "owned-task:example",
          "completed",
        ]),
    ),
  ).toBe(true);
  expect(io.dispatch).not.toHaveBeenCalled();
  expect(io.ordinary).not.toHaveBeenCalled();
});

it("does not lose a terminal notification overlapping an in-flight running status read", async () => {
  seedOwnedReply();
  let finish!: (value: OwnedTaskDispatch) => void;
  io.status.mockImplementationOnce(
    () =>
      new Promise<OwnedTaskDispatch>((resolve) => {
        finish = resolve;
      }),
  );
  const first = reconcileOwnedTaskSession("owned-session");
  await vi.advanceTimersByTimeAsync(0);
  const terminalTrigger = reconcileOwnedTaskSession("owned-session");
  finish(status("running"));
  await expect(Promise.all([first, terminalTrigger])).resolves.toEqual([
    true,
    true,
  ]);
  expect(io.status).toHaveBeenCalledTimes(2);
  expect(io.sync).toHaveBeenCalledOnce();
  expect(
    useChatStore.getState().messagesBySession["owned-session"][1].metadata
      ?.completionStatus,
  ).toBe("completed");
  expect(io.dispatch).not.toHaveBeenCalled();
});

it("preserves native ownership and open reply on a transient read failure, then recovers on the next existing trigger", async () => {
  seedOwnedReply();
  io.get.mockRejectedValueOnce(
    new Error("Native read temporarily unavailable"),
  );
  await expect(reconcileOwnedTaskSession("owned-session")).resolves.toBe(false);
  expect(taskBindingId("owned-session")).toBe("binding");
  expect(
    useChatStore.getState().messagesBySession["owned-session"][0].metadata
      ?.completionStatus,
  ).toBe("inProgress");
  expect(
    useChatStore.getState().getSessionRuntime("owned-session")
      .isRunCancellationPending,
  ).toBe(true);
  expect(io.sync).not.toHaveBeenCalled();
  await expect(reconcileOwnedTaskSession("owned-session")).resolves.toBe(true);
  expect(io.dispatch).not.toHaveBeenCalled();
});

it.each([
  "session",
  "key",
  "run",
  "user",
  "owner",
])("refuses mismatched native %s proof without synthesizing terminal completion", async (field) => {
  seedOwnedReply();
  const altered = { ...status("terminal") };
  if (field === "session") altered.sessionId = "unrelated-session";
  if (field === "key") altered.requestKey = "unrelated-key";
  if (field === "run") altered.runId = "unrelated-run";
  if (field === "user") altered.userMessageId = "unrelated-message";
  if (field === "owner")
    io.get.mockResolvedValue({
      ...prepared,
      session: {
        ...prepared.session,
        owned: { ...prepared.session.owned, ownerId: "task:unrelated-binding" },
      },
    });
  io.status.mockResolvedValue(altered);
  await expect(reconcileOwnedTaskSession("owned-session")).resolves.toBe(false);
  expect(io.sync).not.toHaveBeenCalled();
  expect(io.transcript).not.toHaveBeenCalled();
  expect(
    useChatStore.getState().messagesBySession["owned-session"][0].metadata
      ?.completionStatus,
  ).toBe("inProgress");
  expect(io.dispatch).not.toHaveBeenCalled();
});

it("projects inactive native terminal evidence without loading its transcript or creating chat runtime", async () => {
  observeExecutionOwner("owned-session", { kind: "task", id: "task:binding" });
  io.status.mockResolvedValue(status("terminal"));
  io.receipt.mockResolvedValue(record(receipt));
  await expect(reconcileOwnedTaskSession("owned-session")).resolves.toBe(true);
  expect(io.sync).toHaveBeenCalledOnce();
  expect(io.transcript).not.toHaveBeenCalled();
  expect(useChatStore.getState().messagesBySession).toEqual({});
  expect(useChatStore.getState().sessionStateById).toEqual({});
});

it("settles the native journal while replay owns the transcript and completes its final messages after replay finishes", async () => {
  seedOwnedReply();
  useChatStore.getState().setSessionLoading("owned-session", true);
  await expect(reconcileOwnedTaskSession("owned-session")).resolves.toBe(true);
  expect(io.sync).toHaveBeenCalledOnce();
  expect(io.transcript).not.toHaveBeenCalled();
  expect(
    useChatStore.getState().messagesBySession["owned-session"][0].metadata
      ?.completionStatus,
  ).toBe("inProgress");
  useChatStore.getState().setSessionLoading("owned-session", false);
  await expect(reconcileOwnedTaskSession("owned-session")).resolves.toBe(true);
  expect(
    useChatStore.getState().messagesBySession["owned-session"][1].metadata
      ?.completionStatus,
  ).toBe("completed");
  expect(io.dispatch).not.toHaveBeenCalled();
});
