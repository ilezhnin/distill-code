import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import {
  enqueueStreamingTextUpdate,
  flushAllBufferedStreamingUpdates,
} from "@/features/chat/acp/liveStreamingUpdates";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { resetSessionTargetCoordinatorsForTests } from "@/features/chat/lib/sessionTargetCoordinator";
import type { SessionChatRuntime } from "@/shared/types/chat";
import { QueuedMessageOwnershipLostError } from "./preCommitSendRejection";
import { isQueuedSessionReady } from "./queuedMessageReadiness";
import { dispatchPrompt } from "./sendCore";
import { steerPromptInSession } from "./steerCore";
import {
  clearAccountQuotaWait,
  isAccountQuotaWaiting,
} from "./accountQuotaWait";

const mocks = vi.hoisted(() => ({
  acpSendMessage: vi.fn(),
  acpSteerMessage: vi.fn(),
  acpPrepareSession: vi.fn(),
}));
vi.mock("./chatExecutorDispatch", () => ({
  prepareChatExecutorDispatch: vi.fn(async () => undefined),
}));

describe("dispatchPrompt account quota deferral", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAccountQuotaWait("quota-session");
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
    });
  });

  it("commits no transcript message when preflight waits for a quota reset", async () => {
    const error = {
      data: { kind: "account_quota_wait", promptNotAccepted: true },
    };
    mocks.acpSendMessage.mockRejectedValueOnce(error);
    await expect(
      dispatchPrompt("quota-session", "queued task", {}),
    ).rejects.toBe(error);
    expect(
      useChatStore.getState().messagesBySession["quota-session"] ?? [],
    ).toEqual([]);
    expect(isAccountQuotaWaiting("quota-session")).toBe(true);
    expect(
      isQueuedSessionReady(
        useChatStore.getState().getSessionRuntime("quota-session"),
      ),
    ).toBe(false);
    clearAccountQuotaWait("quota-session");
  });

  it("retracts only the optimistic user message when the host proves zero activity and rollback", async () => {
    const error = {
      data: { kind: "account_quota_wait", promptNotAccepted: true },
    };
    mocks.acpSendMessage.mockImplementationOnce(
      (
        _id: string,
        _prompt: string,
        options: { onPromptDispatching(): void },
      ) => {
        options.onPromptDispatching();
        return Promise.reject(error);
      },
    );
    await expect(
      dispatchPrompt("quota-session", "queued task", {}),
    ).rejects.toBe(error);
    expect(
      useChatStore.getState().messagesBySession["quota-session"] ?? [],
    ).toEqual([]);
    expect(isAccountQuotaWaiting("quota-session")).toBe(true);
    clearAccountQuotaWait("quota-session");
  });

  it("keeps an already dispatched turn without rollback proof and never marks it retryable", async () => {
    const error = {
      message: "Quota interrupted the turn",
      data: { kind: "account_quota_wait", promptNotAccepted: false },
    };
    mocks.acpSendMessage.mockImplementationOnce(
      (
        _id: string,
        _prompt: string,
        options: { onPromptDispatching(): void },
      ) => {
        options.onPromptDispatching();
        return Promise.reject(error);
      },
    );
    await expect(
      dispatchPrompt("quota-session", "partially executed task", {}),
    ).rejects.toBe(error);
    expect(
      useChatStore
        .getState()
        .messagesBySession["quota-session"]?.some(
          (message) => message.role === "user",
        ),
    ).toBe(true);
    expect(isAccountQuotaWaiting("quota-session")).toBe(false);
  });
});

vi.mock("@/shared/api/acp", () => ({
  acpSendMessage: (...args: unknown[]) => mocks.acpSendMessage(...args),
  acpSteerMessage: (...args: unknown[]) => mocks.acpSteerMessage(...args),
  acpPrepareSession: (...args: unknown[]) => mocks.acpPrepareSession(...args),
}));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("dispatchPrompt Ultracode provider boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
    });
    mocks.acpSendMessage.mockResolvedValue(undefined);
  });

  it.each([
    "zai-acp",
    "kimi-acp",
    "codex-acp",
    "claude-acp",
    undefined,
  ])("uses the session harness %s before appending a synthetic keyword", async (harnessId) => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "effort-session",
          title: "Example",
          executionTarget: harnessId ? { harnessId } : undefined,
          createdAt: "now",
          updatedAt: "now",
          messageCount: 0,
          ultracodeArmed: true,
          reasoningEffort: {
            configId: "effort",
            currentValue: "max",
            options: [
              { id: "low", name: "Low" },
              { id: "max", name: "Max" },
            ],
          },
        },
      ],
    });
    await dispatchPrompt("effort-session", "Explain this function", {
      // The pending assistant label is not the session's execution target.
      providerId: harnessId === "claude-acp" ? "zai-acp" : "claude-acp",
    });
    expect(mocks.acpSendMessage).toHaveBeenCalledWith(
      "effort-session",
      harnessId === "claude-acp"
        ? "Explain this function\n\nultracode"
        : "Explain this function",
      expect.any(Object),
    );
  });
});

describe("dispatchPrompt pre-commit rejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: false,
    });
  });

  it("preserves the complete newer-owner runtime on ownership loss", async () => {
    let newerOwnerRuntime: SessionChatRuntime | undefined;
    mocks.acpSendMessage.mockImplementationOnce(
      (
        _sessionId: string,
        _prompt: string,
        options: { onPromptDispatching(): void },
      ) => {
        const store = useChatStore.getState();
        store.setError("session-1", "newer owner error");
        store.setChatState("session-1", "streaming");
        store.setPendingAssistantProvider("session-1", "newer-provider");
        store.setActiveRunId("session-1", "newer-run");
        store.setRunCancellationPending("session-1", true);
        newerOwnerRuntime = structuredClone(
          store.getSessionRuntime("session-1"),
        );
        options.onPromptDispatching();
        return Promise.resolve();
      },
    );

    await expect(
      dispatchPrompt("session-1", "stale queued turn", {
        beforeUserMessageCommitted: () => {
          throw new QueuedMessageOwnershipLostError();
        },
      }),
    ).rejects.toBeInstanceOf(QueuedMessageOwnershipLostError);

    expect(
      useChatStore.getState().messagesBySession["session-1"],
    ).toBeUndefined();
    expect(useChatStore.getState().getSessionRuntime("session-1")).toEqual(
      newerOwnerRuntime,
    );
  });
});

describe("dispatchPrompt model rejection recovery", () => {
  const PINNED = {
    harnessId: "codex-acp",
    modelProviderId: "codex-acp",
    modelId: "gpt-5.6-sol",
    modelName: "GPT 5.6 Sol",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionTargetCoordinatorsForTests();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: false,
    });
    useAgentStore.setState({
      providers: [{ id: "codex-acp", label: "Codex" }],
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Chat",
          executionTarget: PINNED,
          workingDir: "/repo/app",
          createdAt: "now",
          updatedAt: "now",
          messageCount: 0,
        },
      ],
    });
  });

  function failWith(message: string) {
    mocks.acpSendMessage.mockImplementationOnce(
      (
        _sessionId: string,
        _prompt: string,
        options: { onPromptDispatching(): void },
      ) => {
        options.onPromptDispatching();
        return Promise.reject(new Error(message));
      },
    );
  }

  // Not a retry (Q2): re-running the prompt on a model the operator did not
  // choose is the silent substitution D5 forbids.
  it("does not re-send the message it just repaired the target for", async () => {
    failWith("Request failed: Failed to set ACP model option: Invalid params");

    await expect(dispatchPrompt("session-1", "hello", {})).rejects.toThrow();

    expect(mocks.acpSendMessage).toHaveBeenCalledTimes(1);
  });
});

// A turn that errors or is cancelled used to leave the same trace as one that
// answered: none. These pin that all three ways out report, and that a
// pre-commit rejection — which hands the session on having changed nothing —
// still does not.

// A steer stores the steer response's run id on the runtime while the prompt
// is still in flight, and the host drains the steer inside that same
// `session/prompt`. Nothing but the prompt's own settlement can therefore
// clear the run: every send gate (`isQueuedSessionReady`) requires
// `activeRunId === null`, so a run id left behind wedges the chat until the
// app restarts.
describe("dispatchPrompt run settlement after a steer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionTargetCoordinatorsForTests();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: true,
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Chat",
          executionTarget: { harnessId: "claude-acp" },
          createdAt: "now",
          updatedAt: "now",
          messageCount: 0,
        },
      ],
      activeSessionId: null,
      activeWorkspaceBySession: {},
      hasHydratedSessions: true,
    });
  });

  function startPrompt() {
    const send = deferred<void>();
    mocks.acpSendMessage.mockImplementationOnce(
      (
        _sessionId: string,
        _prompt: string,
        options: { onPromptDispatching(): void },
      ) => {
        options.onPromptDispatching();
        return send.promise;
      },
    );
    const dispatch = dispatchPrompt("session-1", "first prompt", {});
    return { send, dispatch };
  }

  it("settles a stop issued after a steer once the prompt settles", async () => {
    mocks.acpSteerMessage.mockResolvedValue({
      runId: "run-2",
      messageId: "steer-1",
    });
    const { send, dispatch } = startPrompt();
    await Promise.resolve();
    expect(await steerPromptInSession("session-1", "also do X")).toBe(true);

    // Stop: the cancel request is in flight and the prompt is the only thing
    // that can settle it (useChat's stop path leaves the run to the prompt
    // whenever `activeRunId` is set).
    const store = useChatStore.getState();
    store.setRunCancellationPending("session-1", true);
    store.setChatState("session-1", "idle");

    send.reject(new DOMException("The operation was aborted.", "AbortError"));
    await expect(dispatch).rejects.toThrow();

    const runtime = useChatStore.getState().getSessionRuntime("session-1");
    expect(runtime.activeRunId).toBeNull();
    expect(runtime.isRunCancellationPending).toBe(false);
    expect(isQueuedSessionReady(runtime)).toBe(true);
  });

  // A rejected `session/prompt` does not stop the bridge, so the rest of the
  // reply keeps arriving after the prompt settled. Those chunks used to be
  // buffered under the owner the prompt had just released — matched by no
  // flush, so never rendered and never freed.
  it("still renders the reply the host streams after the prompt failed", async () => {
    const { send, dispatch } = startPrompt();
    await Promise.resolve();

    const store = useChatStore.getState();
    store.setMessages("session-1", [
      {
        id: "assistant-1",
        role: "assistant",
        created: 1,
        content: [],
        metadata: { userVisible: true, completionStatus: "inProgress" },
      },
    ]);
    store.setStreamingMessageId("session-1", "assistant-1");
    enqueueStreamingTextUpdate("session-1", "assistant-1", "half a rep");
    flushAllBufferedStreamingUpdates();

    send.reject(new Error("ACP connection closed"));
    await expect(dispatch).rejects.toThrow("ACP connection closed");

    enqueueStreamingTextUpdate("session-1", "assistant-1", "ly");
    flushAllBufferedStreamingUpdates();

    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content,
    ).toEqual([{ type: "text", text: "half a reply" }]);
  });
});
