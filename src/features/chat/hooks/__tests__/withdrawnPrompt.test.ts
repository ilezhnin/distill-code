import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { loadSessionMessages } from "../../lib/sessionActivation";
import { DEFAULT_CHAT_TITLE } from "../../lib/sessionTitle";
import { resetTranscriptHydrationForTests } from "../../lib/transcriptHydration";
import { resetSessionTargetCoordinatorsForTests } from "../../lib/sessionTargetCoordinator";
import { useChatStore } from "../../stores/chatStore";
import { useChatSessionStore } from "../../stores/chatSessionStore";
import type { DeferredWorkspaceSend } from "../../lib/firstWorkspaceSend";
import { clearReplayBuffer, ensureReplayBuffer } from "../replayBuffer";
import { useChat } from "../useChat";
import { useMessageQueue } from "../useMessageQueue";

const mocks = vi.hoisted(() => ({
  acpSendMessage: vi.fn(),
  acpGetSessionInfo: vi.fn(),
  acpLoadSession: vi.fn(),
}));

vi.mock("../../lib/chatExecutorDispatch", () => ({
  prepareChatExecutorDispatch: vi.fn(async () => undefined),
  needsInitialChatExecutor: () => false,
  prepareQueuedInitialChatExecutor: vi.fn(async () => undefined),
}));

vi.mock("../../lib/ownedTaskDispatch", () => ({
  dispatchOwnedTaskInChat: vi.fn(),
  reconcileOwnedTaskSession: vi.fn(async () => false),
}));

vi.mock("@/shared/api/acp", () => ({
  acpSendMessage: (...args: unknown[]) => mocks.acpSendMessage(...args),
  acpGetSessionInfo: (...args: unknown[]) => mocks.acpGetSessionInfo(...args),
  acpLoadSession: (...args: unknown[]) => mocks.acpLoadSession(...args),
  acpPrepareSession: vi.fn(async () => undefined),
  acpCancelSession: vi.fn(async () => true),
  acpSteerMessage: vi.fn(),
}));

vi.mock("@/shared/api/pathResolver", () => ({
  resolvePath: vi.fn(async (path: string) => path),
  checkDirectoriesExist: vi.fn(async () => []),
}));

vi.mock("@/features/chat/acp/acpNotificationHandler", () => ({
  getReplayPerf: () => undefined,
  clearReplayPerf: vi.fn(),
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

const REFUSAL =
  "Z.ai refuses requests: insufficient balance or no resource package.";

/** What the host answers once it has withdrawn a refused prompt. */
function withdrawnRefusal() {
  return {
    code: -32603,
    message: "Internal error",
    data: {
      message: REFUSAL,
      dispatchStarted: false,
      promptNotAccepted: true,
    },
  };
}

function seedNewChat() {
  useChatSessionStore.setState({
    sessions: [
      {
        id: "s1",
        title: DEFAULT_CHAT_TITLE,
        executionTarget: { harnessId: "zai-acp" },
        workingDir: null,
        createdAt: "2026-10-31T00:00:00.000Z",
        updatedAt: "2026-10-31T00:00:00.000Z",
        messageCount: 0,
      },
    ],
    activeSessionId: "s1",
    activeWorkspaceBySession: {},
    hasHydratedSessions: true,
  });
}

function renderChat() {
  return renderHook(() => {
    const chat = useChat("s1");
    const queue = useMessageQueue("s1", chat.chatState, chat.sendMessage);
    return { chat, queue };
  });
}

function transcriptText(): string[] {
  return (useChatStore.getState().messagesBySession.s1 ?? []).flatMap(
    (message) =>
      message.content.flatMap((content) =>
        content.type === "text" || content.type === "systemNotification"
          ? [`${message.role}:${content.text}`]
          : [],
      ),
  );
}

describe("a first prompt the host withdrew", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionTargetCoordinatorsForTests();
    resetTranscriptHydrationForTests();
    clearReplayBuffer("s1");
    seedNewChat();
    useAgentStore.setState({ personas: [], agents: [], activeAgentId: null });
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      loadingSessionIds: new Set(),
      activeSessionId: "s1",
      isConnected: true,
    });
  });

  it("comes back first in its queue with the error, survives the replay, and is not re-sent", async () => {
    const turn = deferred();
    mocks.acpSendMessage.mockImplementation(
      (
        _sessionId: string,
        _prompt: string,
        options: {
          onPromptDispatching?: () => void;
          onPromptDispatched?: () => void;
        },
      ) => {
        options.onPromptDispatching?.();
        options.onPromptDispatched?.();
        return turn.promise;
      },
    );
    // The host recorded the prompt before the load asked for the session, and
    // serializes the load behind the running turn.
    mocks.acpGetSessionInfo.mockResolvedValue({
      sessionId: "s1",
      title: null,
      updatedAt: null,
      createdAt: null,
      lastMessageAt: null,
      archivedAt: null,
      userSetName: false,
      messageCount: 1,
      subtitle: null,
      workingDir: null,
      projectId: null,
      providerId: null,
      modelId: null,
      personaId: null,
    });
    const loadGate = deferred<undefined>();
    mocks.acpLoadSession.mockReturnValue(loadGate.promise);

    renderChat();
    act(() => {
      useChatStore.getState().enqueueTransportReadyMessage("s1", {
        persona: { kind: "none" },
        text: "hi",
      });
    });
    await waitFor(() => expect(mocks.acpSendMessage).toHaveBeenCalledTimes(1));
    const sent = useChatStore.getState().queuedMessageBySession.s1;
    expect(sent).toBeUndefined();
    expect(transcriptText()).toEqual(["user:hi"]);

    let load!: Promise<boolean>;
    act(() => {
      load = loadSessionMessages("s1");
    });
    await waitFor(() => expect(mocks.acpLoadSession).toHaveBeenCalledTimes(1));
    act(() => {
      useChatStore.getState().enqueueTransportReadyMessage("s1", {
        persona: { kind: "none" },
        text: "are you there?",
      });
    });

    await act(async () => {
      turn.reject(withdrawnRefusal());
      await turn.promise.catch(() => undefined);
    });
    // The host's history no longer holds the prompt: it replays nothing.
    ensureReplayBuffer("s1");
    await act(async () => {
      loadGate.resolve(undefined);
      await expect(load).resolves.toBe(true);
    });

    const queue = useChatStore.getState().queuedMessageBySession.s1;
    expect(queue.map((record) => record.payload.text)).toEqual([
      "hi",
      "are you there?",
    ]);
    expect(queue[0].kind).toBe("deferred");
    const parked = (queue[0] as { state: DeferredWorkspaceSend }).state;
    expect(parked.status).toBe("failed");
    expect(parked.error).toBe(REFUSAL);
    // Sending it again is a new chat task; the refused one keeps its record.
    expect(queue[0].payload.executorRequestKey).toMatch(/^chat:[0-9a-f-]{36}$/);
    // No duplicate turn, no stale count, no "Couldn't refresh" notice.
    expect(transcriptText()).toEqual([]);
    expect(useChatSessionStore.getState().getSession("s1")?.messageCount).toBe(
      0,
    );
    expect(useChatStore.getState().getSessionRuntime("s1").chatState).toBe(
      "idle",
    );

    act(() => useChatStore.getState().setChatState("s1", "idle"));
    await act(async () => Promise.resolve());
    expect(mocks.acpSendMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps the quota wait's restore: the head stays sendable for when the account can serve it", async () => {
    const turn = deferred();
    mocks.acpSendMessage.mockImplementation(
      (
        _sessionId: string,
        _prompt: string,
        options: {
          onPromptDispatching?: () => void;
          onPromptDispatched?: () => void;
        },
      ) => {
        options.onPromptDispatching?.();
        options.onPromptDispatched?.();
        return turn.promise;
      },
    );
    renderChat();
    act(() => {
      useChatStore.getState().enqueueTransportReadyMessage("s1", {
        persona: { kind: "none" },
        text: "hi",
      });
    });
    await waitFor(() => expect(mocks.acpSendMessage).toHaveBeenCalledTimes(1));
    await act(async () => {
      turn.reject({
        data: { kind: "account_quota_wait", promptNotAccepted: true },
      });
      await turn.promise.catch(() => undefined);
    });

    const queue = useChatStore.getState().queuedMessageBySession.s1;
    expect(queue).toHaveLength(1);
    expect(queue[0].kind).toBe("transport-ready");
    expect(queue[0].payload.text).toBe("hi");
    expect(transcriptText()).toEqual([]);
  });
});
