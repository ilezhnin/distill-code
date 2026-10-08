import { beforeEach, expect, it, vi } from "vitest";
import {
  executorSelection,
  type ApplicationExecutorRequest,
  type ExecutorDecision,
  type ExecutorHostReceipt,
} from "@/features/benchmarks/lib/executorSelection";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { useChatStore } from "../stores/chatStore";
import { prepareChatExecutorDispatch } from "./chatExecutorDispatch";
import { dispatchPrompt } from "./sendCore";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/shared/api/acp", async (original) => ({
  ...(await original<typeof import("@/shared/api/acp")>()),
  acpSendMessage: mocks.send,
}));
vi.mock("@/features/benchmarks/lib/executorSelection", () => ({
  executorSelection: { get: vi.fn(), select: vi.fn(), prepare: vi.fn() },
}));

function decision(request: ApplicationExecutorRequest): ExecutorDecision {
  return {
    request: {
      requestKey: request.requestKey,
      surface: "chat",
      contextId: request.contextId,
      prediction: {
        task: request.task,
        targetFamily: request.targetFamily,
        targetGroup: request.targetGroup,
        candidates: request.candidates,
        hardCandidateKey: request.hardCandidateId,
        minQuality: 0,
      },
      priorKeys: request.priorIds,
      modelId: null,
    },
    chosen: request.candidates[0]?.configuration ?? null,
    chosenKey: "native-key",
    source: request.hardCandidateId ? "pin" : "none",
    reason: "bound_session",
    inputHash: "input",
    artifactHash: "artifact",
    createdAt: 1,
    policyVersion: "test",
    learnedStatus: "unavailable",
    researchPrediction: null,
    learnedDispatchAllowed: false,
  };
}

function rejectedReceipt(
  requestKey: string,
  automaticAccountRouting: boolean,
): ExecutorHostReceipt {
  return {
    start: {
      link: { decisionKey: requestKey, logicalRunId: requestKey },
      sessionId: "example-chat",
      hostRunId: "native-rejected-run",
      messageId: "native-rejected-message",
      bridgeGeneration: 1,
      providerId: "codex-acp",
      accountId: "example-account",
      startedAt: "2026-01-01T00:00:00Z",
      selection: {
        modelId: "example-model",
        modelName: null,
        effort: "xhigh",
        fast: false,
      },
    },
    finish: {
      finishedAt: "2026-01-01T00:00:01Z",
      status: "failed",
      selection: {
        modelId: "example-model",
        modelName: null,
        effort: "xhigh",
        fast: false,
      },
      changes: [],
      changesTruncated: false,
    },
    rejection: {
      reason: "quota_not_accepted",
      confirmedAt: "2026-01-01T00:00:02Z",
      accountId: "example-account",
      automaticAccountRouting,
    },
    attemptIndex: 0,
    previousAttempts: [],
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  useChatSessionStore.setState({
    sessions: [
      {
        id: "example-chat",
        title: "Example",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        messageCount: 1,
        accountId: "example-account",
        executionTarget: {
          harnessId: "codex-acp",
          modelProviderId: "codex-acp",
          modelId: "example-model",
          modelName: "Example model",
        },
        reasoningEffort: {
          configId: "effort",
          currentValue: "xhigh",
          options: [{ id: "xhigh", name: "Extra high" }],
        },
        desiredRunSettings: { effort: "ultra" },
        fastMode: { configId: "fast", enabled: false, kind: "boolean" },
      },
    ],
  });
  useChatStore.setState({
    messagesBySession: {},
    sessionStateById: {},
    queuedMessageBySession: {},
  });
  vi.mocked(executorSelection.get).mockResolvedValue(null);
  vi.mocked(executorSelection.select).mockImplementation(async (request) =>
    decision(request),
  );
  mocks.send.mockImplementation(async (_id, _text, options) => {
    options.onPromptDispatching();
    options.onPromptDispatched?.();
  });
});

it("prepares the actual accepted prompt before dispatch and forwards a durable native receipt join", async () => {
  await dispatchPrompt("example-chat", "Inspect the attached example.", {
    executorRequestKey: "chat:accepted-example",
    persona: { id: "example-role" },
    systemPrompt: "Actual role and workspace context.",
    assistantPrompt: "Use the supplied skill.",
    attachments: [
      {
        id: "file",
        kind: "file",
        name: "example.txt",
        path: "E:/Example/example.txt",
      },
    ],
  });
  expect(executorSelection.select).toHaveBeenCalledWith(
    expect.objectContaining({
      requestKey: "chat:accepted-example",
      hardCandidateId: expect.any(String),
      modelId: null,
      task: expect.objectContaining({
        roleId: "example-role",
        rolePrompt: "Actual role and workspace context.",
        executionProfile: "interactive_acp",
      }),
    }),
    true,
  );
  const request = vi.mocked(executorSelection.select).mock.calls[0][0];
  expect(request.task.prompt).toContain("Use the supplied skill.");
  expect(request.task.prompt).toContain('"E:/Example/example.txt"');
  expect(request.task.fixtures).toEqual([]);
  expect(request.task.entry?.conversationPrefix).toContain(
    '"reportedMessageCount":1',
  );
  expect(request.candidates[0].configuration).toMatchObject({
    providerId: "codex-acp",
    modelId: "example-model",
    accountId: "example-account",
    effort: "xhigh",
    fastMode: false,
  });
  expect(
    vi.mocked(executorSelection.select).mock.invocationCallOrder[0],
  ).toBeLessThan(mocks.send.mock.invocationCallOrder[0]);
  expect(mocks.send).toHaveBeenCalledWith(
    "example-chat",
    expect.any(String),
    expect.objectContaining({
      promptMeta: expect.objectContaining({
        executorSelection: {
          decisionKey: "chat:accepted-example",
          logicalRunId: "chat:accepted-example",
        },
      }),
    }),
  );
});

it("does not commit or call ACP when preparation fails, and reuses the accepted identity", async () => {
  vi.mocked(executorSelection.select).mockRejectedValueOnce(
    new Error("decision store unavailable"),
  );
  const options = { executorRequestKey: "chat:retry-example" };
  await expect(
    dispatchPrompt("example-chat", "Do the example.", options),
  ).rejects.toThrow("decision store unavailable");
  expect(mocks.send).not.toHaveBeenCalled();
  expect(
    useChatStore.getState().messagesBySession["example-chat"] ?? [],
  ).toEqual([]);
  await dispatchPrompt("example-chat", "Do the example.", options);
  expect(
    vi
      .mocked(executorSelection.select)
      .mock.calls.map(([request]) => request.requestKey),
  ).toEqual(["chat:retry-example", "chat:retry-example"]);
});

it("reuses the original immutable preparation when only live history and composed context change", async () => {
  const input = {
    sessionId: "example-chat",
    requestKey: "chat:prepared-retry",
    prompt: "Accepted example",
    systemPrompt: "Original accepted context",
  };
  await prepareChatExecutorDispatch(input);
  const saved = decision(vi.mocked(executorSelection.select).mock.calls[0][0]);
  vi.mocked(executorSelection.get).mockResolvedValue({
    decision: saved,
    hostExecution: null,
    observations: [],
  });
  vi.mocked(executorSelection.prepare).mockResolvedValue(saved);
  useChatStore.getState().addMessage("example-chat", {
    id: "history",
    role: "assistant",
    created: 2,
    content: [{ type: "text", text: "Later visible history" }],
    metadata: { userVisible: true, agentVisible: true },
  });
  await prepareChatExecutorDispatch({
    ...input,
    systemPrompt: "Newly loaded context",
  });
  expect(executorSelection.select).toHaveBeenCalledOnce();
  expect(executorSelection.prepare).toHaveBeenCalledWith(saved.request);
  expect(saved.request.prediction.task.rolePrompt).toBe(
    "Original accepted context",
  );
  expect(saved.request.prediction.task.entry?.conversationPrefix).not.toContain(
    "Later visible history",
  );
});

it("refuses a prepared retry on a changed account before ACP with an actionable recovery error", async () => {
  const input = {
    sessionId: "example-chat",
    requestKey: "chat:prepared-account",
    prompt: "Accepted example",
  };
  await prepareChatExecutorDispatch(input);
  const saved = decision(vi.mocked(executorSelection.select).mock.calls[0][0]);
  vi.mocked(executorSelection.get).mockResolvedValue({
    decision: saved,
    hostExecution: null,
    observations: [],
  });
  useChatSessionStore
    .getState()
    .patchSession("example-chat", { accountId: "new-account" });
  await expect(
    dispatchPrompt("example-chat", input.prompt, {
      executorRequestKey: input.requestKey,
    }),
  ).rejects.toThrow(/restore|edit/i);
  expect(mocks.send).not.toHaveBeenCalled();
});

it("refuses a restored or unknown-outcome dispatch when the host already recorded execution", async () => {
  vi.mocked(executorSelection.get).mockResolvedValue({
    hostExecution: { start: {}, finish: { status: "completed" } },
    observations: [],
  } as never);
  await expect(
    dispatchPrompt("example-chat", "Do not duplicate.", {
      executorRequestKey: "chat:already-started",
    }),
  ).rejects.toThrow("already has a recorded execution");
  expect(executorSelection.select).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
  expect(
    useChatStore.getState().messagesBySession["example-chat"] ?? [],
  ).toEqual([]);
});

it.each([
  false,
  true,
])("retries a host-proven quota withdrawal with immutable decision identity (automatic routing: %s)", async (automatic) => {
  const input = {
    sessionId: "example-chat",
    requestKey: "chat:withdrawn-retry",
    prompt: "Accepted example",
  };
  await prepareChatExecutorDispatch(input);
  const saved = decision(vi.mocked(executorSelection.select).mock.calls[0][0]);
  vi.mocked(executorSelection.get).mockResolvedValue({
    decision: saved,
    hostExecution: rejectedReceipt(input.requestKey, automatic),
    observations: [],
  });
  vi.mocked(executorSelection.prepare).mockResolvedValue(saved);
  if (automatic)
    useChatSessionStore
      .getState()
      .patchSession("example-chat", { accountId: "native-routed-account" });
  await dispatchPrompt("example-chat", input.prompt, {
    executorRequestKey: input.requestKey,
  });
  expect(executorSelection.select).toHaveBeenCalledOnce();
  expect(executorSelection.prepare).toHaveBeenCalledWith(saved.request);
  expect(saved.chosen?.accountId).toBe("example-account");
  expect(mocks.send).toHaveBeenCalledOnce();
  expect(mocks.send.mock.calls[0][2].promptMeta.executorSelection).toEqual({
    decisionKey: input.requestKey,
    logicalRunId: input.requestKey,
  });
});

it.each([
  "unknown",
  "ordinary-failure",
  "wrong-session",
  "wrong-task",
  "manual-account",
  "changed-model",
  "changed-settings",
  "observed",
] as const)("refuses a prepared retry with %s evidence before ACP", async (change) => {
  const input = {
    sessionId: "example-chat",
    requestKey: "chat:unsafe-retry",
    prompt: "Accepted example",
  };
  await prepareChatExecutorDispatch(input);
  const saved = decision(vi.mocked(executorSelection.select).mock.calls[0][0]);
  const receipt = rejectedReceipt(
    input.requestKey,
    change !== "manual-account",
  );
  if (change === "unknown") receipt.finish = null;
  if (change === "ordinary-failure") receipt.rejection = null;
  if (change === "wrong-session") receipt.start.sessionId = "other-chat";
  if (change === "wrong-task") receipt.start.link.logicalRunId = "other-task";
  if (change === "manual-account")
    useChatSessionStore
      .getState()
      .patchSession("example-chat", { accountId: "manual-new-account" });
  if (change === "changed-model")
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget("example-chat", {
        harnessId: "codex-acp",
        modelProviderId: "codex-acp",
        modelId: "other-model",
        modelName: "Other model",
      });
  if (change === "changed-settings")
    useChatSessionStore.getState().patchSession("example-chat", {
      fastMode: { configId: "fast", enabled: true, kind: "boolean" },
    });
  vi.mocked(executorSelection.get).mockResolvedValue({
    decision: saved,
    hostExecution: receipt,
    observations:
      change === "observed"
        ? [
            {
              createdAt: 1,
              matchesSelected: null,
              observation: {
                phase: "started",
                sessionId: "example-chat",
                runId: input.requestKey,
                configuration: null,
                outcome: null,
                reason: null,
              },
            },
          ]
        : [],
  });
  await expect(
    dispatchPrompt("example-chat", input.prompt, {
      executorRequestKey: input.requestKey,
    }),
  ).rejects.toThrow();
  expect(executorSelection.prepare).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});

it("rejects native substitution of a bound manual target and catches configuration changes before commit", async () => {
  vi.mocked(executorSelection.select).mockImplementationOnce(
    async (request) => ({ ...decision(request), source: "prior" }),
  );
  await expect(
    prepareChatExecutorDispatch({
      sessionId: "example-chat",
      requestKey: "chat:pin",
      prompt: "Example",
    }),
  ).rejects.toThrow("preserve the prepared chat target");
  const prepared = await prepareChatExecutorDispatch({
    sessionId: "example-chat",
    requestKey: "chat:race",
    prompt: "Example",
  });
  useChatSessionStore
    .getState()
    .patchSession("example-chat", { accountId: "changed-account" });
  expect(prepared.assertCurrent).toThrow("superseded");
});

it("keeps an existing wave receipt link without creating a second chat decision", async () => {
  await dispatchPrompt("example-chat", "Existing wave task.", {
    acpPromptMetadata: {
      executorSelection: {
        decisionKey: "wave:example:step:0",
        logicalRunId: "wave-run",
      },
    },
  });
  expect(executorSelection.select).not.toHaveBeenCalled();
  expect(executorSelection.get).not.toHaveBeenCalled();
  expect(mocks.send).toHaveBeenCalledWith(
    "example-chat",
    expect.any(String),
    expect.objectContaining({
      promptMeta: expect.objectContaining({
        executorSelection: {
          decisionKey: "wave:example:step:0",
          logicalRunId: "wave-run",
        },
      }),
    }),
  );
});

it("gives accepted edits a new decision identity without changing queue position or later payloads", () => {
  const chat = useChatStore.getState();
  chat.enqueueTransportReadyMessage("example-chat", {
    text: "Original",
    persona: { kind: "inherit" },
  });
  chat.enqueueTransportReadyMessage("example-chat", {
    text: "Later",
    persona: { kind: "none" },
  });
  const [head, later] =
    useChatStore.getState().queuedMessageBySession["example-chat"];
  expect(head.payload.executorRequestKey).toMatch(/^chat:/);
  chat.updateQueuedMessage("example-chat", head.recordId, {
    ...head.payload,
    text: "Edited",
    persona: { kind: "none" },
  });
  const [edited, untouched] =
    useChatStore.getState().queuedMessageBySession["example-chat"];
  expect(edited.recordId).toBe(head.recordId);
  expect(edited.payload.executorRequestKey).not.toBe(
    head.payload.executorRequestKey,
  );
  expect(untouched).toBe(later);
});

it("preserves the accepted decision identity when a failed dispatch only reveals the queued composer text", () => {
  const chat = useChatStore.getState();
  chat.enqueueTransportReadyMessage("example-chat", {
    text: "Retry the accepted task",
    persona: { kind: "inherit" },
    showInComposer: false,
  });
  const head =
    useChatStore.getState().queuedMessageBySession["example-chat"][0];
  chat.updateQueuedMessage("example-chat", head.recordId, {
    ...head.payload,
    showInComposer: true,
  });
  const revealed =
    useChatStore.getState().queuedMessageBySession["example-chat"][0];
  expect(revealed.payload.executorRequestKey).toBe(
    head.payload.executorRequestKey,
  );
});
