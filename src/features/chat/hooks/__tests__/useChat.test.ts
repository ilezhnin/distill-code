import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatStore } from "../../stores/chatStore";
import {
  useChatSessionStore,
  type ChatSession,
} from "../../stores/chatSessionStore";
import type { Message } from "@/shared/types/messages";
import { clearReplayBuffer } from "../replayBuffer";
import { clearStreamingMessageOwners } from "../../acp/liveStreamingUpdates";

const mockAcpSendMessage = vi.fn();
const mockAcpSteerMessage = vi.fn();
const mockAcpCancelSession = vi.fn();
const mockAcpLoadSession = vi.fn();
const mockAcpPrepareSession = vi.fn();
let mockAcpDispatches = true;

vi.mock("@/shared/api/acp", () => ({
  acpSendMessage: (...args: unknown[]) => {
    const result = mockAcpSendMessage(...args);
    const options = args[2] as
      | {
          onPromptDispatching?: () => void;
          onPromptDispatched?: () => void;
        }
      | undefined;
    if (mockAcpDispatches) {
      options?.onPromptDispatching?.();
      options?.onPromptDispatched?.();
    }
    return result;
  },
  acpSteerMessage: (...args: unknown[]) => mockAcpSteerMessage(...args),
  acpCancelSession: (...args: unknown[]) => mockAcpCancelSession(...args),
  acpLoadSession: (...args: unknown[]) => mockAcpLoadSession(...args),
  acpPrepareSession: (...args: unknown[]) => mockAcpPrepareSession(...args),
}));

import { handleSessionNotification } from "../../acp/acpNotificationHandler";
import { useChat } from "../useChat";

function addStreamingAssistantMessage(
  sessionId: string,
  messageId: string,
  personaId: string,
  personaName: string,
) {
  const message: Message = {
    id: messageId,
    role: "assistant",
    created: Date.now(),
    content: [],
    metadata: {
      userVisible: true,
      agentVisible: true,
      personaId,
      personaName,
      completionStatus: "inProgress",
    },
  };

  useChatStore.getState().addMessage(sessionId, message);
  useChatStore.getState().setStreamingMessageId(sessionId, messageId);
}

function createDeferredPromise<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function seedChatSession(overrides: Partial<ChatSession> = {}) {
  useChatSessionStore.setState({
    sessions: [
      {
        id: "session-1",
        title: "New Chat",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
        messageCount: 0,
        ...overrides,
      },
    ],
  });
}

describe("useChat", () => {
  beforeEach(() => {
    mockAcpSendMessage.mockReset();
    mockAcpSteerMessage.mockReset();
    mockAcpCancelSession.mockReset();
    mockAcpLoadSession.mockReset();
    mockAcpPrepareSession.mockReset();
    mockAcpDispatches = true;
    clearReplayBuffer("session-1");
    clearReplayBuffer("session-2");
    clearStreamingMessageOwners();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      activeSessionId: null,
      isConnected: true,
    });
    useChatSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      isRightRailOpen: false,
      activeWorkspaceBySession: {},
    });
    useAgentStore.setState({
      personas: [
        {
          id: "persona-a",
          displayName: "Persona A",
          systemPrompt: "",
          isBuiltin: false,
          writable: true,
          createdAt: "",
          updatedAt: "",
        },
        {
          id: "persona-b",
          displayName: "Persona B",
          systemPrompt: "",
          isBuiltin: false,
          writable: true,
          createdAt: "",
          updatedAt: "",
        },
      ],
      personasLoading: false,
      agents: [],
      agentsLoading: false,
      activeAgentId: null,
      isLoading: false,
    });
    mockAcpSendMessage.mockResolvedValue(undefined);
    mockAcpSteerMessage.mockResolvedValue({
      runId: "run-1",
      messageId: "steer-message",
    });
    mockAcpCancelSession.mockResolvedValue(true);
    mockAcpLoadSession.mockResolvedValue(undefined);
    mockAcpPrepareSession.mockResolvedValue(undefined);
  });

  it("marks the streaming message stopped only after cancellation succeeds", async () => {
    const cancelDeferred = createDeferredPromise<boolean>();
    mockAcpCancelSession.mockReturnValue(cancelDeferred.promise);

    const { result } = renderHook(() => useChat("session-1"));

    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-1",
        "persona-a",
        "Persona A",
      );
      useChatStore.getState().setChatState("session-1", "streaming");
    });

    act(() => {
      result.current.stopGeneration();
    });

    let message = useChatStore.getState().messagesBySession["session-1"][0];
    const runtime = useChatStore.getState().getSessionRuntime("session-1");

    expect(message.metadata?.completionStatus).toBe("inProgress");
    expect(runtime.chatState).toBe("idle");
    expect(runtime.streamingMessageId).toBeNull();

    await act(async () => {
      cancelDeferred.resolve(true);
      await cancelDeferred.promise;
    });

    message = useChatStore.getState().messagesBySession["session-1"][0];
    expect(message.metadata?.completionStatus).toBe("stopped");
  });

  it("ignores a stale cancellation after a newer stop begins", async () => {
    const firstCancellation = createDeferredPromise<boolean>();
    const secondCancellation = createDeferredPromise<boolean>();
    mockAcpCancelSession
      .mockReturnValueOnce(firstCancellation.promise)
      .mockReturnValueOnce(secondCancellation.promise);

    const { result } = renderHook(() => useChat("session-1"));
    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-1",
        "persona-a",
        "Persona A",
      );
      useChatStore.getState().setChatState("session-1", "streaming");
      result.current.stopGeneration();
      useChatStore.getState().settleActiveRun("session-1");
      addStreamingAssistantMessage(
        "session-1",
        "assistant-2",
        "persona-a",
        "Persona A",
      );
      useChatStore.getState().setChatState("session-1", "streaming");
      result.current.stopGeneration();
      useChatStore.getState().setStreamingMessageId("session-1", "assistant-2");
    });

    await act(async () => {
      firstCancellation.resolve(true);
      await firstCancellation.promise;
    });

    const runtime = useChatStore.getState().getSessionRuntime("session-1");
    expect(runtime.isRunCancellationPending).toBe(true);
    expect(runtime.streamingMessageId).toBe("assistant-2");
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.metadata
        ?.completionStatus,
    ).toBe("inProgress");

    await act(async () => {
      secondCancellation.resolve(false);
      await secondCancellation.promise;
    });
  });

  it("does not mark a newer follow-up idle when the stopped prompt settles", async () => {
    const firstPromptDeferred = createDeferredPromise<void>();
    const secondPromptDeferred = createDeferredPromise<void>();
    mockAcpSendMessage
      .mockReturnValueOnce(firstPromptDeferred.promise)
      .mockReturnValueOnce(secondPromptDeferred.promise);

    const { result } = renderHook(() => useChat("session-1"));

    let firstSendPromise!: Promise<boolean>;
    await act(async () => {
      firstSendPromise = result.current.sendMessage("first prompt");
      await Promise.resolve();
    });

    act(() => {
      useChatStore.getState().setActiveRunId("session-1", "run-1");
      result.current.stopGeneration();
      useChatStore.getState().setActiveRunId("session-1", null);
      useChatStore.getState().setRunCancellationPending("session-1", false);
    });

    let secondSendPromise!: Promise<boolean>;
    await act(async () => {
      secondSendPromise = result.current.sendMessage("second prompt");
      await Promise.resolve();
    });

    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-2",
        "persona-a",
        "Persona A",
      );
      useChatStore.getState().setActiveRunId("session-1", "run-2");
    });

    await act(async () => {
      firstPromptDeferred.resolve();
      await firstSendPromise;
    });

    const runtime = useChatStore.getState().getSessionRuntime("session-1");
    expect(runtime.chatState).toBe("streaming");
    expect(runtime.streamingMessageId).toBe("assistant-2");
    expect(runtime.activeRunId).toBe("run-2");

    await act(async () => {
      secondPromptDeferred.resolve();
      await secondSendPromise;
    });
  });

  it("does not clear cancellation state owned by a newer prompt", async () => {
    const firstPromptDeferred = createDeferredPromise<void>();
    const secondPromptDeferred = createDeferredPromise<void>();
    mockAcpSendMessage
      .mockReturnValueOnce(firstPromptDeferred.promise)
      .mockReturnValueOnce(secondPromptDeferred.promise);

    const { result } = renderHook(() => useChat("session-1"));

    let firstSendPromise!: Promise<boolean>;
    await act(async () => {
      firstSendPromise = result.current.sendMessage("first prompt");
      await Promise.resolve();
    });

    act(() => {
      useChatStore.getState().setActiveRunId("session-1", "run-1");
      result.current.stopGeneration();
      useChatStore.getState().setActiveRunId("session-1", null);
      useChatStore.getState().setRunCancellationPending("session-1", false);
    });

    let secondSendPromise!: Promise<boolean>;
    await act(async () => {
      secondSendPromise = result.current.sendMessage("second prompt");
      await Promise.resolve();
    });

    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-2",
        "persona-a",
        "Persona A",
      );
      useChatStore.getState().setActiveRunId("session-1", "run-2");
      result.current.stopGeneration();
    });

    await act(async () => {
      firstPromptDeferred.resolve();
      await firstSendPromise;
    });

    let runtime = useChatStore.getState().getSessionRuntime("session-1");
    expect(runtime.chatState).toBe("idle");
    expect(runtime.streamingMessageId).toBeNull();
    expect(runtime.activeRunId).toBe("run-2");
    expect(runtime.isRunCancellationPending).toBe(true);

    await act(async () => {
      secondPromptDeferred.resolve();
      await secondSendPromise;
    });

    runtime = useChatStore.getState().getSessionRuntime("session-1");
    expect(runtime.activeRunId).toBeNull();
    expect(runtime.isRunCancellationPending).toBe(false);
  });

  it("keeps a delivered steer when the acknowledgement is lost", async () => {
    const steerDeferred = createDeferredPromise<{
      runId: string;
      messageId: string;
    }>();
    mockAcpSteerMessage.mockReturnValue(steerDeferred.promise);
    useChatStore.getState().setActiveRunId("session-1", "run-1");
    useChatStore.getState().setChatState("session-1", "streaming");
    const { result } = renderHook(() => useChat("session-1"));

    let steerPromise!: Promise<boolean>;
    await act(async () => {
      steerPromise = result.current.steerMessage("make it shorter");
      await Promise.resolve();
    });

    await act(async () => {
      await handleSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "backend-steer-message",
          content: { type: "text", text: "make it shorter" },
          _meta: { distill: { steer: true } },
        },
      } as never);
    });

    let accepted: boolean | undefined;
    await act(async () => {
      steerDeferred.reject(new Error("connection closed"));
      accepted = await steerPromise;
    });

    expect(accepted).toBe(true);
    const messages = useChatStore.getState().messagesBySession["session-1"];
    expect(messages[0]).toMatchObject({
      id: "backend-steer-message",
      role: "user",
      metadata: { delivery: "steer" },
    });
    expect(
      messages.filter((message) => message.role === "system"),
    ).toHaveLength(0);
  });

  it("does not restore a stale active run when stop wins a race with steer acknowledgement", async () => {
    const steerDeferred = createDeferredPromise<{
      runId: string;
      messageId: string;
    }>();
    mockAcpSteerMessage.mockReturnValue(steerDeferred.promise);
    useChatStore.getState().setActiveRunId("session-1", "run-1");
    useChatStore.getState().setChatState("session-1", "streaming");

    const { result } = renderHook(() => useChat("session-1"));

    let steerPromise!: Promise<boolean>;
    await act(async () => {
      steerPromise = result.current.steerMessage("make it shorter");
      await Promise.resolve();
    });

    let cancellation!: Promise<boolean>;
    act(() => {
      cancellation = result.current.stopGeneration();
    });

    expect(
      useChatStore.getState().getSessionRuntime("session-1")
        .isRunCancellationPending,
    ).toBe(true);

    act(() => {
      // Mirror the backend's active-run-cleared notification after it accepts
      // cancellation, but before the steer request returns to the caller.
      useChatStore.getState().setActiveRunId("session-1", null);
      useChatStore.getState().setRunCancellationPending("session-1", false);
    });

    await act(async () => {
      steerDeferred.resolve({ runId: "run-1", messageId: "steer-message" });
      await Promise.all([steerPromise, cancellation]);
    });

    expect(
      useChatStore.getState().getSessionRuntime("session-1").chatState,
    ).toBe("idle");
    expect(
      useChatStore.getState().getSessionRuntime("session-1").activeRunId,
    ).toBeNull();
    expect(
      useChatStore.getState().getSessionRuntime("session-1")
        .isRunCancellationPending,
    ).toBe(false);
  });

  it("allows another session to send while a different session is streaming", async () => {
    const deferred = createDeferredPromise();
    mockAcpSendMessage
      .mockReturnValueOnce(deferred.promise)
      .mockResolvedValueOnce(undefined);

    const firstSession = renderHook(() => useChat("session-1"));
    const secondSession = renderHook(() => useChat("session-2"));

    let firstPromise!: Promise<boolean>;
    await act(async () => {
      firstPromise = firstSession.result.current.sendMessage("First");
      await Promise.resolve();
    });

    await act(async () => {
      await secondSession.result.current.sendMessage("Second");
    });

    expect(mockAcpSendMessage).toHaveBeenNthCalledWith(
      1,
      "session-1",
      "First",
      expect.objectContaining({
        systemPrompt: undefined,
        personaId: undefined,
        personaName: undefined,
        images: undefined,
      }),
    );
    expect(mockAcpSendMessage).toHaveBeenNthCalledWith(
      2,
      "session-2",
      "Second",
      expect.objectContaining({
        systemPrompt: undefined,
        personaId: undefined,
        personaName: undefined,
        images: undefined,
      }),
    );

    deferred.resolve();
    await act(async () => {
      await firstPromise;
    });
  });

  it("reports acceptance at user-turn commitment before the agent run settles", async () => {
    const deferred = createDeferredPromise();
    mockAcpSendMessage.mockReturnValue(deferred.promise);

    const { result } = renderHook(() => useChat("session-1"));

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.sendMessage("queued turn");
    });

    expect(accepted).toBe(true);
    expect(useChatStore.getState().messagesBySession["session-1"]).toHaveLength(
      1,
    );
    expect(
      useChatStore.getState().getSessionRuntime("session-1").chatState,
    ).toBe("streaming");

    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });
  });

  it("rejects queue acceptance when preparation fails before dispatch", async () => {
    const { result } = renderHook(() =>
      useChat("session-1", undefined, undefined, undefined, {
        ensurePrepared: vi.fn().mockResolvedValue(false),
      }),
    );

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.sendMessage("queued turn");
    });

    expect(accepted).toBe(false);
    expect(mockAcpSendMessage).not.toHaveBeenCalled();
  });

  it("does not commit a user turn when ACP setup fails before transport", async () => {
    mockAcpDispatches = false;
    mockAcpSendMessage.mockRejectedValueOnce(
      new Error("ACP client unavailable"),
    );
    const { result } = renderHook(() => useChat("session-1"));

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.sendMessage("queued turn");
    });

    expect(accepted).toBe(false);
    expect(
      useChatStore.getState().messagesBySession["session-1"] ?? [],
    ).toEqual([]);
  });

  it("does not revoke acceptance when the dispatched agent run fails", async () => {
    mockAcpSendMessage.mockRejectedValue(new Error("run failed"));
    const { result } = renderHook(() => useChat("session-1"));

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.sendMessage("queued turn");
      await Promise.resolve();
    });

    expect(accepted).toBe(true);
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0],
    ).toMatchObject({ role: "user" });
  });

  it("does not prompt when preparation is superseded", async () => {
    seedChatSession({ workingDir: "/tmp/project" });
    const ensurePrepared = vi.fn().mockResolvedValue(false);

    const { result } = renderHook(() =>
      useChat("session-1", undefined, undefined, undefined, {
        ensurePrepared,
      }),
    );

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    expect(ensurePrepared).toHaveBeenCalledTimes(1);
    expect(mockAcpSendMessage).not.toHaveBeenCalled();

    const messages = useChatStore.getState().messagesBySession["session-1"];
    const runtime = useChatStore.getState().getSessionRuntime("session-1");

    expect(messages).toBeUndefined();
    expect(runtime.error).toBe(
      "Session configuration changed while preparing. Try sending again.",
    );
    expect(runtime.chatState).toBe("idle");
    expect(runtime.streamingMessageId).toBeNull();
    expect(
      useChatSessionStore.getState().getSession("session-1")
        ?.workspaceAttachments,
    ).toBeUndefined();
  });
});
