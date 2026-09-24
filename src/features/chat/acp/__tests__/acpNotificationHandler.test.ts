import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearReplayBuffer,
  getReplayBuffer,
} from "@/features/chat/hooks/replayBuffer";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { replaceMessagesFromSessionReplay } from "@/features/chat/lib/sessionReplayReplacement";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import {
  clearMessageTracking,
  handleSessionNotification,
  reportPermissionAnswer,
} from "../acpNotificationHandler";
import { flushBufferedStreamingUpdatesForSession } from "../liveStreamingUpdates";
import { setActiveMessageId } from "@/shared/api/acpActiveMessageTracking";
import { isLegacyReplayReplyId } from "@/shared/api/acpReplayMetadata";
import { registerPreparedSession } from "@/shared/api/acpSessionRegistry";
import { claimSessionPrompt } from "@/features/chat/lib/sessionPromptOwnership";
import {
  getUsageLedger,
  resetUsageLedgerForTests,
} from "@/features/stats/lib/usageLedger";

const workspaceObservationMocks = vi.hoisted(() => ({
  clearWorkspaceToolCallObservations: vi.fn(),
  observeWorkspaceToolCall: vi.fn(),
}));
vi.mock("../acpWorkspaceObservation", () => workspaceObservationMocks);

function markSessionReplayLoading(sessionId = "acp-session") {
  useChatStore.setState({
    loadingSessionIds: new Set([sessionId]),
  });
}

describe("acpNotificationHandler", () => {
  beforeEach(() => {
    resetUsageLedgerForTests();
    workspaceObservationMocks.clearWorkspaceToolCallObservations.mockClear();
    workspaceObservationMocks.observeWorkspaceToolCall.mockClear();
    clearMessageTracking();
    clearReplayBuffer("acp-session");
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: false,
      loadingSessionIds: new Set<string>(),
      scrollTargetMessageBySession: {},
    });
    useChatSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      hasHydratedSessions: true,
      isRightRailOpen: false,
      activeWorkspaceBySession: {},
    });
    useAgentStore.setState({ personas: [] });
  });

  // Reopening a chat replays every usage_update the host persisted. Feeding
  // those to the ledger moves the chat's activity to today and rewrites the
  // whole ledger once per replayed turn; only the live turn is real usage.
  it("does not record usage into the ledger while replaying history", async () => {
    const usageUpdate = {
      sessionUpdate: "usage_update",
      used: 1200,
      size: 200000,
      cost: { amount: 0.42, currency: "USD" },
      accumulatedInputTokens: 1000,
      accumulatedOutputTokens: 200,
    } as const;

    markSessionReplayLoading();
    await handleSessionNotification({
      sessionId: "acp-session",
      update: usageUpdate,
    } as never);

    expect(getUsageLedger().sessions["acp-session"]).toBeUndefined();
    replaceMessagesFromSessionReplay("acp-session", {
      historyExpectation: "empty",
    });
    // The chat's own context/cost readout is still restored on replay.
    expect(
      useChatStore.getState().sessionStateById["acp-session"]?.tokenState,
    ).toMatchObject({
      accumulatedTotal: 1200,
      accumulatedInput: 1000,
      accumulatedOutput: 200,
      accumulatedCost: 0.42,
      costBilling: "estimate",
    });

    useChatStore.setState({ loadingSessionIds: new Set<string>() });
    await handleSessionNotification({
      sessionId: "acp-session",
      update: usageUpdate,
    } as never);

    expect(getUsageLedger().sessions["acp-session"]).toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.42,
      started: true,
    });
  });

  it("publishes historical usage once after replay instead of waking the chat for every update", async () => {
    markSessionReplayLoading();
    const changed = vi.fn();
    const unsubscribe = useChatStore.subscribe(
      (state) => state.sessionStateById["acp-session"]?.tokenState,
      changed,
    );
    try {
      for (let index = 1; index <= 150; index += 1) {
        await handleSessionNotification({
          sessionId: "acp-session",
          update: {
            sessionUpdate: "usage_update",
            used: index * 10,
            size: 200000,
            cost: { amount: index / 100, currency: "USD" },
          },
        } as never);
      }
      expect(changed).not.toHaveBeenCalled();
      replaceMessagesFromSessionReplay("acp-session", {
        historyExpectation: "empty",
      });
      expect(changed).toHaveBeenCalledTimes(1);
      expect(
        useChatStore.getState().sessionStateById["acp-session"]?.tokenState,
      ).toMatchObject({
        accumulatedTotal: 1500,
        contextLimit: 200000,
        accumulatedCost: 1.5,
      });
    } finally {
      unsubscribe();
    }
  });

  it("folds partial replay usage in order, including an explicit cost reset", async () => {
    const store = useChatStore.getState();
    store.updateTokenState("acp-session", {
      accumulatedInput: 100,
      accumulatedOutput: 20,
      contextLimit: 200000,
      accumulatedCost: 9,
    });
    markSessionReplayLoading();
    for (const update of [
      {
        accumulatedInputTokens: 150,
        cost: { amount: 1, currency: "USD", _meta: { billed: true } },
      },
      { accumulatedOutputTokens: 30 },
      { cost: null },
      { used: 500 },
    ]) {
      await handleSessionNotification({
        sessionId: "acp-session",
        update: { sessionUpdate: "usage_update", ...update },
      } as never);
    }
    replaceMessagesFromSessionReplay("acp-session", {
      historyExpectation: "empty",
    });
    expect(
      useChatStore.getState().sessionStateById["acp-session"]?.tokenState,
    ).toMatchObject({
      accumulatedInput: 150,
      accumulatedOutput: 30,
      accumulatedTotal: 500,
      contextLimit: 200000,
      accumulatedCost: null,
      costBilling: null,
    });
  });

  it.each([
    "failed",
    "invalid",
  ])("discards usage from a %s replay before retrying", async (outcome) => {
    markSessionReplayLoading();
    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "usage_update",
        used: 900,
        size: 200000,
        cost: { amount: 9, currency: "USD" },
      },
    } as never);
    if (outcome === "failed") {
      clearReplayBuffer("acp-session");
    } else {
      expect(
        replaceMessagesFromSessionReplay("acp-session", {
          historyExpectation: "nonempty",
        }),
      ).toEqual({ status: "invalid", reason: "empty" });
    }
    expect(
      useChatStore.getState().sessionStateById["acp-session"]?.hasUsageSnapshot,
    ).not.toBe(true);
    await handleSessionNotification({
      sessionId: "acp-session",
      update: { sessionUpdate: "usage_update", used: 10 },
    } as never);
    replaceMessagesFromSessionReplay("acp-session", {
      historyExpectation: "empty",
    });
    expect(
      useChatStore.getState().sessionStateById["acp-session"]?.tokenState,
    ).toMatchObject({
      accumulatedTotal: 10,
      contextLimit: 0,
      accumulatedCost: null,
    });
  });

  it("marks session cost billed only when usage cost meta says so", async () => {
    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "usage_update",
        used: 100,
        size: 1000,
        cost: {
          amount: 1.5,
          currency: "USD",
          _meta: { billed: true },
        },
      },
    } as never);

    expect(
      useChatStore.getState().sessionStateById["acp-session"]?.tokenState,
    ).toMatchObject({
      accumulatedCost: 1.5,
      costBilling: "billed",
    });
  });

  it("keeps assistant responses in canonical order when multiple steers arrive before the next response", async () => {
    useChatStore.getState().setMessages("acp-session", [
      {
        id: "assistant-before-steers",
        role: "assistant",
        created: 1,
        content: [{ type: "text", text: "Browser-level echo cancellation" }],
        metadata: {
          userVisible: true,
          agentVisible: true,
          completionStatus: "inProgress",
          personaId: "persona-a",
        },
      },
      {
        id: "steer-1",
        role: "user",
        created: 2,
        content: [{ type: "text", text: "is it based on the browser?" }],
        metadata: {
          userVisible: true,
          agentVisible: true,
          delivery: "steer",
        },
      },
      {
        id: "steer-2",
        role: "user",
        created: 2,
        content: [{ type: "text", text: "are we using a browser?" }],
        metadata: {
          userVisible: true,
          agentVisible: true,
          delivery: "steer",
        },
      },
    ]);
    useChatStore
      .getState()
      .setStreamingMessageId("acp-session", "assistant-before-steers");
    useChatStore.getState().setPendingInterventionBoundary("acp-session", {
      interventionMessageId: "steer-1",
    });

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "steer-1",
        content: { type: "text", text: "is it based on the browser?" },
        _meta: { distill: { steer: true } },
      },
    } as never);

    const continuationMessageId =
      useChatStore.getState().getSessionRuntime("acp-session")
        .streamingMessageId ?? "";

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-after-steers",
        content: { type: "text", text: "Tauri desktop app" },
      },
    } as never);

    flushBufferedStreamingUpdatesForSession("acp-session", {
      flushSubtitle: true,
    });

    const messages = useChatStore.getState().messagesBySession["acp-session"];
    expect(messages).toMatchObject([
      { id: "assistant-before-steers", role: "assistant" },
      { id: "steer-1", role: "user" },
      { id: "steer-2", role: "user" },
      {
        id: continuationMessageId,
        role: "assistant",
        content: [{ type: "text", text: "Tauri desktop app" }],
      },
    ]);
    expect(messages[0].metadata?.completionStatus).toBe("completed");
    expect(
      useChatStore.getState().getSessionRuntime("acp-session")
        .streamingMessageId,
    ).toBe(continuationMessageId);
  });

  it("correlates overlapping delivery-before-ack steers in send order", async () => {
    useChatStore.getState().setMessages("acp-session", [
      {
        id: "local-steer-1",
        role: "user",
        created: 1,
        content: [{ type: "text", text: "first steer" }],
        metadata: {
          userVisible: true,
          agentVisible: true,
          delivery: "steering",
        },
      },
      {
        id: "local-steer-2",
        role: "user",
        created: 2,
        content: [{ type: "text", text: "second steer" }],
        metadata: {
          userVisible: true,
          agentVisible: true,
          delivery: "steering",
        },
      },
    ]);
    useChatStore.getState().setPendingInterventionBoundary("acp-session", {
      interventionMessageId: "local-steer-2",
    });

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "backend-steer-1",
        content: { type: "text", text: "first steer" },
        _meta: { distill: { steer: true } },
      },
    } as never);

    expect(
      useChatStore.getState().messagesBySession["acp-session"],
    ).toMatchObject([
      { id: "backend-steer-1", metadata: { delivery: "steer" } },
      { role: "assistant" },
      { id: "local-steer-2", metadata: { delivery: "steering" } },
    ]);
    expect(
      useChatStore.getState().getSessionRuntime("acp-session")
        .pendingInterventionBoundary,
    ).toBeNull();
  });

  it("restores overlapping replayed agent-boundary steers in send order", async () => {
    markSessionReplayLoading();

    for (const [messageId, text] of [
      ["steer-replay-1", "first steer"],
      ["steer-replay-2", "second steer"],
    ]) {
      await handleSessionNotification({
        sessionId: "acp-session",
        update: {
          sessionUpdate: "user_message_chunk",
          messageId,
          content: { type: "text", text },
        },
      } as never);
    }
    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-replay-1",
        content: { type: "text", text: "First revised answer" },
        _meta: { distill: { steer: true } },
      },
    } as never);

    const replayMessages = getReplayBuffer("acp-session") ?? [];
    expect(replayMessages).toMatchObject([
      {
        id: "steer-replay-1",
        metadata: { delivery: "steer" },
      },
      { id: "steer-replay-2" },
      { id: "assistant-replay-1", role: "assistant" },
    ]);
    expect(replayMessages[1].metadata?.delivery).toBeUndefined();
  });

  it("attributes a completed live tool response to the matching request when a sibling is still executing", async () => {
    // Regression: with two sibling tool requests, completing the first
    // while the second is still unpaired must label the response with the
    // first request's name. Previously the live path used the latest
    // unpaired request, which could swap names across siblings.
    registerPreparedSession("acp-session", "goose", "/Users/test");
    setActiveMessageId("acp-session", "assistant-1");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-a",
        title: "read_file",
        rawInput: { path: "/tmp/notes.md" },
      },
    } as never);

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-b",
        title: "grep",
        rawInput: { pattern: "TODO" },
      },
    } as never);

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-a",
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "file contents" },
          },
        ],
      },
    } as never);

    const [message] = useChatStore.getState().messagesBySession["acp-session"];
    expect(message.content.map((block) => block.type)).toEqual([
      "toolRequest",
      "toolRequest",
      "toolResponse",
    ]);
    expect(message.content[0]).toMatchObject({
      type: "toolRequest",
      id: "tool-a",
      name: "read_file",
      status: "completed",
    });
    expect(message.content[1]).toMatchObject({
      type: "toolRequest",
      id: "tool-b",
      name: "grep",
      status: "in_progress",
    });
    expect(message.content[2]).toMatchObject({
      type: "toolResponse",
      id: "tool-a",
      name: "read_file",
      result: "file contents",
      isError: false,
    });
  });

  it("does not redirect a late chunk with its original message id into the current stream", async () => {
    registerPreparedSession("acp-session", "goose", "/Users/test");
    claimSessionPrompt("acp-session");
    setActiveMessageId("acp-session", "assistant-1");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: { type: "text", text: "first response" },
      },
    } as never);
    flushBufferedStreamingUpdatesForSession("acp-session");

    const firstMessages =
      useChatStore.getState().messagesBySession["acp-session"] ?? [];
    useChatStore.setState((state) => ({
      ...state,
      messagesBySession: {
        ...state.messagesBySession,
        "acp-session": [
          ...firstMessages,
          {
            id: "assistant-2",
            role: "assistant",
            created: Date.now(),
            content: [],
            metadata: {
              userVisible: true,
              agentVisible: true,
              completionStatus: "inProgress",
            },
          },
        ],
      },
    }));
    useChatStore.getState().setStreamingMessageId("acp-session", "assistant-2");
    claimSessionPrompt("acp-session");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: { type: "text", text: " late stale text" },
      },
    } as never);
    flushBufferedStreamingUpdatesForSession("acp-session");

    const messages = useChatStore.getState().messagesBySession["acp-session"];
    expect(
      messages.find((message) => message.id === "assistant-1")?.content,
    ).toEqual([{ type: "text", text: "first response" }]);
    expect(
      messages.find((message) => message.id === "assistant-2")?.content,
    ).toEqual([]);
    expect(
      useChatStore.getState().getSessionRuntime("acp-session")
        .streamingMessageId,
    ).toBe("assistant-2");
  });

  it("preserves structured tool output when ACP provides rawOutput", async () => {
    registerPreparedSession(
      "acp-session",
      "goose",
      "/Users/aharvard/.goose/artifacts",
    );
    setActiveMessageId("acp-session", "assistant-1");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "mcp_app_bench__inspect_host_info",
      },
    } as never);

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Opened the Host Info inspector.",
            },
          },
        ],
        rawOutput: {
          inspector: "host-info",
          supported: true,
        },
      },
    } as never);

    const [message] = useChatStore.getState().messagesBySession["acp-session"];
    expect(message.content[1]).toMatchObject({
      type: "toolResponse",
      id: "tool-1",
      result: "Opened the Host Info inspector.",
      structuredContent: {
        inspector: "host-info",
        supported: true,
      },
      isError: false,
    });
  });

  it("replay preserves ordered user text and image chunks", async () => {
    const replaySessionId = "replay-user-image-session";
    useChatStore.setState({
      loadingSessionIds: new Set<string>([replaySessionId]),
    });

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: {
          type: "text",
          text: "what is in this image?",
        },
      },
    } as never);

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: {
          type: "image",
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
        },
      },
    } as never);

    const buffer = getReplayBuffer(replaySessionId);
    expect(buffer).toHaveLength(1);
    expect(buffer?.[0]).toMatchObject({
      id: "user-1",
      role: "user",
      content: [
        { type: "text", text: "what is in this image?" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
      metadata: {
        userVisible: true,
        agentVisible: true,
      },
    });
  });

  it("replay keeps image-only user messages visible", async () => {
    const replaySessionId = "replay-user-image-only-session";
    useChatStore.setState({
      loadingSessionIds: new Set<string>([replaySessionId]),
    });

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "user-image-only",
        content: {
          type: "image",
          uri: "file:///tmp/screenshot.png",
          mimeType: "image/png",
        },
      },
    } as never);

    const buffer = getReplayBuffer(replaySessionId);
    expect(buffer).toHaveLength(1);
    expect(buffer?.[0]).toMatchObject({
      id: "user-image-only",
      role: "user",
      content: [
        {
          type: "image",
          uri: "file:///tmp/screenshot.png",
          mimeType: "image/png",
        },
      ],
      metadata: {
        userVisible: true,
        agentVisible: true,
      },
    });
  });

  it("replays two turns with a steer as prompt, reply, steer, reply", async () => {
    markSessionReplayLoading();
    const turn = (
      sessionUpdate: string,
      distill: Record<string, unknown>,
      extra: Record<string, unknown>,
    ) => ({
      sessionId: "acp-session",
      update: { sessionUpdate, ...extra, _meta: { distill } },
    });
    const firstTurn = { messageId: "user-1", assistantMessageId: "reply-1" };
    const steeredTurn = { messageId: "user-2", assistantMessageId: "reply-2" };

    for (const notification of [
      turn(
        "user_message_chunk",
        { messageId: "user-1" },
        { content: { type: "text", text: "write a poem" } },
      ),
      turn("agent_thought_chunk", firstTurn, {
        content: { type: "text", text: "thinking" },
      }),
      turn("agent_message_chunk", firstTurn, {
        content: { type: "text", text: "Roses " },
      }),
      turn("tool_call", firstTurn, { toolCallId: "tool-1", title: "search" }),
      turn("tool_call_update", firstTurn, {
        toolCallId: "tool-1",
        status: "completed",
      }),
      turn("agent_message_chunk", firstTurn, {
        content: { type: "text", text: "are red" },
      }),
      turn(
        "user_message_chunk",
        { messageId: "user-2", steer: true },
        { content: { type: "text", text: "make it shorter" } },
      ),
      turn("agent_message_chunk", steeredTurn, {
        content: { type: "text", text: "Roses." },
      }),
    ]) {
      await handleSessionNotification(notification as never);
    }

    const replayMessages = getReplayBuffer("acp-session") ?? [];
    expect(replayMessages.map(({ id, role }) => ({ id, role }))).toEqual([
      { id: "user-1", role: "user" },
      { id: "reply-1", role: "assistant" },
      { id: "user-2", role: "user" },
      { id: "reply-2", role: "assistant" },
    ]);
    expect(replayMessages[1].content.map((block) => block.type)).toEqual([
      "thinking",
      "text",
      "toolRequest",
      "toolResponse",
      "text",
    ]);
    expect(replayMessages[1].metadata?.completionStatus).toBe("completed");
    expect(replayMessages[2].metadata?.delivery).toBe("steer");
    expect(replayMessages[3].content).toEqual([
      { type: "text", text: "Roses." },
    ]);
  });

  it("replays history without reply ids as one reply per prompt", async () => {
    markSessionReplayLoading();

    for (const [sessionUpdate, text] of [
      ["user_message_chunk", "hi"],
      ["agent_message_chunk", "hel"],
      ["agent_message_chunk", "lo"],
    ]) {
      await handleSessionNotification({
        sessionId: "acp-session",
        update: {
          sessionUpdate,
          content: { type: "text", text },
          _meta: { distill: { messageId: "user-1" } },
        },
      } as never);
    }

    expect(getReplayBuffer("acp-session")).toMatchObject([
      { id: "user-1", role: "user", content: [{ type: "text", text: "hi" }] },
      {
        id: "user-1:reply",
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
    ]);
  });

  it("gives an id-less reply the same derived id on every load", async () => {
    // A random id read as a brand-new reply on each load, so a fence in it
    // (a wave plan, a memory, a task) was acted on again after every restart.
    const load = async () => {
      clearMessageTracking();
      clearReplayBuffer("acp-session");
      markSessionReplayLoading();
      for (const [sessionUpdate, text] of [
        ["user_message_chunk", "hi"],
        ["agent_message_chunk", "hel"],
        ["agent_message_chunk", "lo"],
      ]) {
        await handleSessionNotification({
          sessionId: "acp-session",
          update: { sessionUpdate, content: { type: "text", text } },
        } as never);
      }
      return (getReplayBuffer("acp-session") ?? []).filter(
        (message) => message.role === "assistant",
      );
    };

    const first = await load();
    const second = await load();

    expect(first).toHaveLength(1);
    expect(first[0].content).toEqual([{ type: "text", text: "hello" }]);
    expect(second.map((message) => message.id)).toEqual(
      first.map((message) => message.id),
    );
    expect(isLegacyReplayReplyId(first[0].id)).toBe(true);
  });

  it("does not repeat a steered prompt whose live echo overlaps a load", async () => {
    markSessionReplayLoading();
    const steerBlock = {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "make it shorter" },
      _meta: { distill: { messageId: "user-2", steer: true } },
    };

    await handleSessionNotification({
      sessionId: "acp-session",
      update: steerBlock,
    } as never);
    await handleSessionNotification({
      sessionId: "acp-session",
      update: { ...steerBlock, messageId: "user-2" },
    } as never);

    expect(getReplayBuffer("acp-session")).toMatchObject([
      {
        id: "user-2",
        content: [{ type: "text", text: "make it shorter" }],
        metadata: { delivery: "steer" },
      },
    ]);
    expect(getReplayBuffer("acp-session")?.[0].content).toHaveLength(1);
  });

  it("continues a replayed reply when its live stream resumes after a load", async () => {
    useChatStore.getState().setMessages("acp-session", [
      {
        id: "user-1",
        role: "user",
        created: 1,
        content: [{ type: "text", text: "write a poem" }],
        metadata: { userVisible: true, agentVisible: true },
      },
      {
        id: "reply-1",
        role: "assistant",
        created: 2,
        content: [{ type: "text", text: "Roses " }],
        metadata: {
          userVisible: true,
          agentVisible: true,
          completionStatus: "inProgress",
        },
      },
    ]);

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "are red" },
        _meta: {
          distill: { messageId: "user-1", assistantMessageId: "reply-1" },
        },
      },
    } as never);
    flushBufferedStreamingUpdatesForSession("acp-session");

    const messages = useChatStore.getState().messagesBySession["acp-session"];
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toEqual([
      { type: "text", text: "Roses are red" },
    ]);
  });
});

// The app answers permission requests itself. A `cancelled` answer ends the
// harness's turn, so the transcript has to say what happened — otherwise the
// operator sees a turn that stopped for no visible reason.
describe("permission answers the operator never saw", () => {
  beforeEach(() => {
    useChatStore.setState({ messagesBySession: {} });
  });

  it("records a system notice when the app could only cancel the request", () => {
    reportPermissionAnswer({
      sessionId: "acp-session",
      toolLabel: "Bash(rm -rf /)",
      answer: "cancelled",
    });

    const messages =
      useChatStore.getState().messagesBySession["acp-session"] ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content[0]).toMatchObject({
      type: "systemNotification",
      notificationType: "warning",
      text: expect.stringContaining("Bash(rm -rf /)"),
    });
  });
});
