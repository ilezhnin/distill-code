import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearReplayBuffer,
  getReplayBuffer,
} from "@/features/chat/hooks/replayBuffer";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import {
  clearMessageTracking,
  handleSessionNotification,
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

function getReplayMessage(sessionId = "acp-session") {
  return getReplayBuffer(sessionId)?.[0];
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
    // The chat's own context/cost readout is still restored on replay.
    expect(
      useChatStore.getState().sessionStateById["acp-session"]?.tokenState,
    ).toMatchObject({
      accumulatedTotal: 1200,
      accumulatedInput: 1000,
      accumulatedOutput: 200,
      accumulatedCost: 0.42,
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

  it("observes live tool updates for workspace registration", async () => {
    const update = {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      kind: "execute",
      status: "completed",
      rawInput: { cwd: "/tmp/worktree" },
    } as const;

    await handleSessionNotification({
      sessionId: "acp-session",
      update,
    } as never);

    expect(
      workspaceObservationMocks.observeWorkspaceToolCall,
    ).toHaveBeenCalledWith("acp-session", update);
  });

  it("does not infer workspace registration while replaying history", async () => {
    markSessionReplayLoading();
    const update = {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      kind: "execute",
      status: "completed",
      rawInput: { cwd: "/tmp/historical-worktree" },
    } as const;

    await handleSessionNotification({
      sessionId: "acp-session",
      update,
    } as never);

    expect(
      workspaceObservationMocks.observeWorkspaceToolCall,
    ).not.toHaveBeenCalled();
  });

  it("renders an image returned by a live tool result as an inline image block", async () => {
    // An image-producing MCP (e.g. imagegenerator) returns the image as an
    // image ContentBlock in the tool result. The completed tool_call_update must
    // surface it as an inline image block after the toolResponse, not drop it.
    registerPreparedSession("acp-session", "goose", "/Users/test");
    setActiveMessageId("acp-session", "assistant-img-tool");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "img-1",
        title: "imagegenerator__generate",
      },
    } as never);

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "img-1",
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "Here is your image." },
          },
          {
            type: "content",
            content: {
              type: "image",
              data: "iVBORw0KGgo=",
              mimeType: "image/png",
            },
          },
        ],
      },
    } as never);

    const [message] = useChatStore.getState().messagesBySession["acp-session"];
    expect(message.content.map((block) => block.type)).toEqual([
      "toolRequest",
      "toolResponse",
      "image",
    ]);
    expect(message.content[2]).toMatchObject({
      type: "image",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    });
  });

  it("attaches active persona identity to the live assistant message", async () => {
    registerPreparedSession("acp-session", "goose", "/Users/test");
    setActiveMessageId("acp-session", "assistant-1", {
      personaId: "persona-1",
      personaName: "Builder",
    });

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Ready to build.",
        },
      },
    } as never);

    flushBufferedStreamingUpdatesForSession("acp-session", {
      flushSubtitle: true,
    });

    const [message] = useChatStore.getState().messagesBySession["acp-session"];
    expect(message).toMatchObject({
      id: "assistant-1",
      role: "assistant",
      metadata: {
        personaId: "persona-1",
        personaName: "Builder",
        completionStatus: "inProgress",
      },
    });
  });

  it("marks a pending steering message delivered at the live stream boundary", async () => {
    useChatStore.getState().setMessages("acp-session", [
      {
        id: "assistant-before-steer",
        role: "assistant",
        created: 1,
        content: [{ type: "text", text: "Initial answer" }],
        metadata: {
          userVisible: true,
          agentVisible: true,
          completionStatus: "inProgress",
          personaId: "persona-a",
          personaName: "Persona A",
        },
      },
      {
        id: "steer-message",
        role: "user",
        created: 2,
        content: [{ type: "text", text: "make it shorter" }],
        metadata: {
          userVisible: true,
          agentVisible: true,
          delivery: "steering",
        },
      },
    ]);
    useChatStore
      .getState()
      .setStreamingMessageId("acp-session", "assistant-before-steer");
    useChatStore.getState().setPendingInterventionBoundary("acp-session", {
      interventionMessageId: "steer-message",
    });

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: " make it shorter can appear naturally",
        },
      },
    } as never);

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "steer-message",
        content: {
          type: "text",
          text: "make it shorter",
        },
        _meta: {
          distill: {
            steer: true,
            messageId: "steer-message",
            activeRunId: "run-2",
          },
        },
      },
    } as never);

    expect(
      useChatStore.getState().messagesBySession["acp-session"][1].metadata
        ?.delivery,
    ).toBe("steer");

    const continuationMessageId =
      useChatStore.getState().getSessionRuntime("acp-session")
        .streamingMessageId ?? "";

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Revised answer",
        },
      },
    } as never);

    flushBufferedStreamingUpdatesForSession("acp-session", {
      flushSubtitle: true,
    });

    const messages = useChatStore.getState().messagesBySession["acp-session"];
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toEqual([
      {
        type: "text",
        text: "Initial answer make it shorter can appear naturally",
      },
    ]);
    expect(messages[2]).toMatchObject({
      id: continuationMessageId,
      role: "assistant",
      content: [{ type: "text", text: "Revised answer" }],
      metadata: {
        completionStatus: "inProgress",
        personaId: "persona-a",
        personaName: "Persona A",
      },
    });
    expect(
      useChatStore.getState().getSessionRuntime("acp-session")
        .pendingInterventionBoundary,
    ).toBeNull();
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

  it("correlates delivery that arrives before the steer acknowledgement", async () => {
    useChatStore.getState().setMessages("acp-session", [
      {
        id: "local-steer-message",
        role: "user",
        created: 1,
        content: [{ type: "text", text: "make it shorter" }],
        metadata: {
          userVisible: true,
          agentVisible: true,
          delivery: "steering",
        },
      },
    ]);
    useChatStore.getState().setPendingInterventionBoundary("acp-session", {
      interventionMessageId: "local-steer-message",
    });

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "backend-steer-message",
        content: { type: "text", text: "make it shorter" },
        _meta: { distill: { steer: true } },
      },
    } as never);

    expect(
      useChatStore.getState().messagesBySession["acp-session"][0],
    ).toMatchObject({
      id: "backend-steer-message",
      metadata: { delivery: "steer" },
    });
    expect(
      useChatStore.getState().getSessionRuntime("acp-session")
        .pendingInterventionBoundary,
    ).toBeNull();
  });

  it("marks a steering message delivered on an agent boundary", async () => {
    useChatStore.getState().setMessages("acp-session", [
      {
        id: "local-steer-message",
        role: "user",
        created: 1,
        content: [{ type: "text", text: "make it shorter" }],
        metadata: {
          userVisible: true,
          agentVisible: true,
          delivery: "steering",
        },
      },
    ]);
    useChatStore.getState().setPendingInterventionBoundary("acp-session", {
      interventionMessageId: "local-steer-message",
    });

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-boundary",
        content: { type: "text", text: "" },
        _meta: { distill: { steer: true } },
      },
    } as never);

    expect(
      useChatStore.getState().messagesBySession["acp-session"],
    ).toMatchObject([
      { id: "local-steer-message", metadata: { delivery: "steer" } },
      { role: "assistant" },
    ]);
    expect(
      useChatStore.getState().getSessionRuntime("acp-session")
        .pendingInterventionBoundary,
    ).toBeNull();
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

  it("restores delivered steer metadata from a replayed agent boundary", async () => {
    markSessionReplayLoading();

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "steer-replay-1",
        content: { type: "text", text: "make it shorter" },
      },
    } as never);
    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-replay-1",
        content: { type: "text", text: "Revised answer" },
        _meta: { distill: { steer: true } },
      },
    } as never);

    expect(getReplayBuffer("acp-session")).toMatchObject([
      {
        id: "steer-replay-1",
        role: "user",
        metadata: { delivery: "steer" },
      },
      { id: "assistant-replay-1", role: "assistant" },
    ]);
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

  it("preserves a later replay steer across ordinary chunks after the first boundary", async () => {
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
    for (const update of [
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-replay-1",
        content: { type: "text", text: "First revised answer" },
        _meta: { distill: { steer: true } },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-replay-1",
        content: { type: "text", text: " continued" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-replay-2",
        content: { type: "text", text: "Second revised answer" },
        _meta: { distill: { steer: true } },
      },
    ]) {
      await handleSessionNotification({
        sessionId: "acp-session",
        update,
      } as never);
    }

    const replayMessages = getReplayBuffer("acp-session") ?? [];
    expect(replayMessages[0].metadata?.delivery).toBe("steer");
    expect(replayMessages[1].metadata?.delivery).toBe("steer");
  });

  it("does not treat a prompt as a steer when a tool event starts its response", async () => {
    markSessionReplayLoading();

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "prompt-replay-1",
        content: { type: "text", text: "ordinary prompt" },
      },
    } as never);
    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call",
        messageId: "assistant-replay-1",
        toolCallId: "tool-1",
        title: "search",
      },
    } as never);
    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "steer-replay-1",
        content: { type: "text", text: "steer prompt" },
      },
    } as never);
    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-replay-2",
        content: { type: "text", text: "Revised answer" },
        _meta: { distill: { steer: true } },
      },
    } as never);

    const replayMessages = getReplayBuffer("acp-session") ?? [];
    expect(replayMessages[0].metadata?.delivery).toBeUndefined();
    expect(replayMessages[2].metadata?.delivery).toBe("steer");
  });

  it("does not carry an id-less ordinary prompt into a later steer boundary", async () => {
    markSessionReplayLoading();

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "prompt-replay-1",
        content: { type: "text", text: "first ordinary prompt" },
      },
    } as never);
    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "First answer" },
      },
    } as never);
    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "prompt-replay-2",
        content: { type: "text", text: "second ordinary prompt" },
      },
    } as never);
    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Second answer" },
      },
    } as never);
    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "steer-replay-1",
        content: { type: "text", text: "actual steer" },
      },
    } as never);
    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Steered answer" },
        _meta: { distill: { steer: true } },
      },
    } as never);

    const replayMessages = getReplayBuffer("acp-session") ?? [];
    const userMessages = replayMessages.filter(
      (message) => message.role === "user",
    );
    expect(userMessages[0].metadata?.delivery).toBeUndefined();
    expect(userMessages[1].metadata?.delivery).toBeUndefined();
    expect(userMessages[2].metadata?.delivery).toBe("steer");
  });

  it("marks a replay assistant completed at the next user turn", async () => {
    markSessionReplayLoading();

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Finished answer" },
      },
    } as never);
    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Next question" },
      },
    } as never);

    expect(getReplayBuffer("acp-session")?.[0]).toMatchObject({
      role: "assistant",
      metadata: { completionStatus: "completed" },
    });
  });

  it("attaches replay assistant persona identity from update metadata", async () => {
    markSessionReplayLoading();

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Ready.",
        },
        _meta: {
          distill: {
            messageId: "user-replay-1",
            assistantMessageId: "assistant-replay-1",
            personaId: "persona-meta",
            personaName: "Meta Persona",
          },
        },
      },
    } as never);

    expect(getReplayMessage()).toMatchObject({
      id: "assistant-replay-1",
      role: "assistant",
      metadata: {
        personaId: "persona-meta",
        personaName: "Meta Persona",
      },
    });
  });

  it("falls back to session persona identity for replay assistant messages", async () => {
    markSessionReplayLoading();
    useChatSessionStore.getState().addSession({
      id: "acp-session",
      title: "Chat",
      personaId: "persona-session",
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      messageCount: 1,
    });
    useAgentStore.setState({
      personas: [
        {
          id: "persona-session",
          displayName: "Session Persona",
          systemPrompt: "",
          isBuiltin: false,
          writable: true,
        },
      ],
    });

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Ready.",
        },
        _meta: {
          distill: {
            messageId: "user-replay-2",
            assistantMessageId: "assistant-replay-2",
          },
        },
      },
    } as never);

    expect(getReplayMessage()).toMatchObject({
      id: "assistant-replay-2",
      role: "assistant",
      metadata: {
        personaId: "persona-session",
        personaName: "Session Persona",
      },
    });
  });

  it("restores replayed user message origin metadata", async () => {
    markSessionReplayLoading();

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "user_message_chunk",
        content: {
          type: "text",
          text: "Cross-session prompt",
        },
        _meta: {
          distill: {
            messageId: "user-replay-1",
            origin: "berdctl_cross_session",
          },
        },
      },
    } as never);

    expect(getReplayMessage()).toMatchObject({
      id: "user-replay-1",
      role: "user",
      metadata: {
        origin: "berdctl_cross_session",
      },
    });
  });

  it.each([
    "live",
    "replay",
  ] as const)("retains codex-acp provenance when identity arrives late in %s", async (mode) => {
    const sessionId = "acp-session";
    if (mode === "live") {
      registerPreparedSession(sessionId, "codex", "/Users/test");
      setActiveMessageId(sessionId, "assistant-1");
    } else {
      markSessionReplayLoading(sessionId);
    }

    await handleSessionNotification({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "followup-1",
        title: "Sending follow-up",
        rawInput: {
          prompt: "Re-check the cache boundary",
          receiverThreadIds: ["/root/reviewer"],
        },
      },
    } as never);
    await handleSessionNotification({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "followup-1",
        _meta: { codex: { collaboration: { tool: "followup_task" } } },
      },
    } as never);

    const messages =
      mode === "live"
        ? useChatStore.getState().messagesBySession[sessionId]
        : getReplayBuffer(sessionId);
    const request = messages
      ?.flatMap((message) => message.content)
      .find(
        (block) => block.type === "toolRequest" && block.id === "followup-1",
      );
    expect(request).toMatchObject({
      type: "toolRequest",
      toolName: "followup_task",
      subagentAgentName: "/root/reviewer",
      subagentTaskLabel: "Re-check the cache boundary",
    });
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

  it("keeps a late live tool response from moving the streaming pointer back to its owner message", async () => {
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

    const beforeMessages =
      useChatStore.getState().messagesBySession["acp-session"] ?? [];
    useChatStore.setState((state) => ({
      ...state,
      messagesBySession: {
        ...state.messagesBySession,
        "acp-session": [
          ...beforeMessages,
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

    expect(
      useChatStore.getState().getSessionRuntime("acp-session")
        .streamingMessageId,
    ).toBe("assistant-2");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Continuing with the answer.",
        },
      },
    } as never);

    flushBufferedStreamingUpdatesForSession("acp-session", {
      flushSubtitle: true,
    });

    const messages = useChatStore.getState().messagesBySession["acp-session"];
    const ownerMessage = messages.find((m) => m.id === "assistant-1");
    const currentMessage = messages.find((m) => m.id === "assistant-2");

    expect(ownerMessage?.content.map((block) => block.type)).toEqual([
      "toolRequest",
      "toolResponse",
    ]);
    expect(currentMessage?.content).toEqual([
      { type: "text", text: "Continuing with the answer." },
    ]);
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

  it("does not apply a late image chunk from a superseded assistant stream", async () => {
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
        content: {
          type: "image",
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
        },
      },
    } as never);

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

  it("replay appends thought deltas verbatim", async () => {
    const replaySessionId = "replay-thought-session";
    useChatStore.setState({
      loadingSessionIds: new Set<string>([replaySessionId]),
    });

    for (const text of ["Plan", " next", " step"]) {
      await handleSessionNotification({
        sessionId: replaySessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          messageId: "assistant-thought-1",
          content: { type: "text", text },
        },
      } as never);
    }

    const buffer = getReplayBuffer(replaySessionId);
    expect(buffer?.[0]?.content).toEqual([
      { type: "thinking", text: "Plan next step" },
    ]);
  });

  // The host stores the raw chunks, so replay sees the same token deltas the
  // live stream did: one that repeats the accumulated tail is real text.
  it("replay keeps thought deltas that repeat the accumulated tail", async () => {
    const replaySessionId = "replay-thought-tail-session";
    useChatStore.setState({
      loadingSessionIds: new Set<string>([replaySessionId]),
    });

    for (const text of [
      "The year was 201",
      "1",
      " and foo(bar(baz)",
      ")",
      ")",
    ]) {
      await handleSessionNotification({
        sessionId: replaySessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          messageId: "assistant-thought-tail",
          content: { type: "text", text },
        },
      } as never);
    }

    const buffer = getReplayBuffer(replaySessionId);
    expect(buffer?.[0]?.content).toEqual([
      { type: "thinking", text: "The year was 2011 and foo(bar(baz)))" },
    ]);
  });

  it("replay restores skill chips from assistant-only user chunks", async () => {
    const replaySessionId = "replay-skill-session";
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
          text: "Use these skills for this request: capture-task.",
          annotations: { audience: ["assistant"] },
        },
      },
    } as never);

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: {
          type: "text",
          text: "redo the settings modal",
        },
      },
    } as never);

    const buffer = getReplayBuffer(replaySessionId);
    expect(buffer).toHaveLength(1);
    expect(buffer?.[0]).toMatchObject({
      id: "user-1",
      role: "user",
      content: [{ type: "text", text: "redo the settings modal" }],
      metadata: {
        chips: [{ label: "capture-task", type: "skill" }],
      },
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

  it("replay appends assistant image chunks in message order", async () => {
    const replaySessionId = "replay-assistant-image-session";
    useChatStore.setState({
      loadingSessionIds: new Set<string>([replaySessionId]),
    });

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: {
          type: "text",
          text: "here is the generated image:",
        },
      },
    } as never);

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: {
          type: "image",
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
          uri: "file:///tmp/generated.png",
        },
      },
    } as never);

    const buffer = getReplayBuffer(replaySessionId);
    expect(buffer).toHaveLength(1);
    expect(buffer?.[0]).toMatchObject({
      id: "assistant-1",
      role: "assistant",
      content: [
        { type: "text", text: "here is the generated image:" },
        {
          type: "image",
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
          uri: "file:///tmp/generated.png",
        },
      ],
    });
  });

  it("appends live assistant image chunks inline during the turn", async () => {
    // Live counterpart to "replay appends assistant image chunks in message
    // order". A session not in loadingSessionIds takes the handleLive path. An
    // image chunk that follows a text chunk must be appended to the streaming
    // assistant message so it renders during the turn (regression guard for the
    // previously-missing live image branch).
    registerPreparedSession("acp-session", "goose", "/Users/test");
    setActiveMessageId("acp-session", "assistant-img-live", {});

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "here is the generated image:",
        },
      },
    } as never);

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "image",
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
          uri: "file:///tmp/generated.png",
        },
      },
    } as never);

    const [message] = useChatStore.getState().messagesBySession["acp-session"];
    expect(message).toMatchObject({
      id: "assistant-img-live",
      role: "assistant",
      content: [
        { type: "text", text: "here is the generated image:" },
        {
          type: "image",
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
          uri: "file:///tmp/generated.png",
        },
      ],
    });
  });

  it("replay preserves timestamps from goose metadata on user and assistant chunks", async () => {
    const replaySessionId = "replay-timestamp-session";
    const userCreated = 1_700_000_000;
    const assistantCreated = 1_700_000_120;
    useChatStore.setState({
      loadingSessionIds: new Set<string>([replaySessionId]),
    });

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        content: {
          type: "text",
          text: "what time was this sent?",
        },
        _meta: {
          distill: {
            messageId: "user-from-meta",
            created: userCreated,
          },
        },
      },
    } as never);

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "At the original replay time.",
        },
        _meta: {
          distill: {
            messageId: "user-from-meta",
            assistantMessageId: "assistant-from-meta",
            created: assistantCreated,
          },
        },
      },
    } as never);

    const buffer = getReplayBuffer(replaySessionId);
    expect(buffer?.[0]).toMatchObject({
      id: "user-from-meta",
      role: "user",
      created: userCreated * 1000,
    });
    expect(buffer?.[1]).toMatchObject({
      id: "assistant-from-meta",
      role: "assistant",
      created: assistantCreated * 1000,
    });
  });

  it("replay falls back to tracked assistant when a tool update ID is not buffered", async () => {
    const replaySessionId = "replay-tool-response-id-session";
    const assistantCreated = 1_700_000_120;
    const toolResponseCreated = 1_700_000_240;
    useChatStore.setState({
      loadingSessionIds: new Set<string>([replaySessionId]),
    });

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "I'll check that.",
        },
        _meta: {
          distill: {
            messageId: "user-1",
            assistantMessageId: "assistant-1",
            created: assistantCreated,
          },
        },
      },
    } as never);

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Tool completed.",
            },
          },
        ],
        _meta: {
          distill: {
            messageId: "tool-response-user-message",
            created: toolResponseCreated,
          },
        },
      },
    } as never);

    const buffer = getReplayBuffer(replaySessionId);
    const assistant = buffer?.[0];
    expect(assistant).toMatchObject({
      id: "assistant-1",
      created: assistantCreated * 1000,
    });
    expect(assistant?.content.map((block) => block.type)).toEqual([
      "text",
      "toolResponse",
    ]);
    expect(assistant?.content[1]).toMatchObject({
      type: "toolResponse",
      id: "tool-1",
      result: "Tool completed.",
      isError: false,
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

  it("streams a live reply under the id the host names it with", async () => {
    setActiveMessageId("acp-session", "local-preset", {
      personaId: "persona-1",
    });

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello" },
        _meta: {
          distill: { messageId: "user-1", assistantMessageId: "reply-1" },
        },
      },
    } as never);
    flushBufferedStreamingUpdatesForSession("acp-session");

    expect(
      useChatStore.getState().messagesBySession["acp-session"],
    ).toMatchObject([
      {
        id: "reply-1",
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        metadata: { personaId: "persona-1" },
      },
    ]);
    expect(
      useChatStore.getState().getSessionRuntime("acp-session")
        .streamingMessageId,
    ).toBe("reply-1");
  });

  it("names the continuation after a steer with the steered turn's reply id", async () => {
    useChatStore.getState().setMessages("acp-session", [
      {
        id: "reply-1",
        role: "assistant",
        created: 1,
        content: [{ type: "text", text: "Initial answer" }],
        metadata: {
          userVisible: true,
          agentVisible: true,
          completionStatus: "inProgress",
        },
      },
      {
        id: "user-2",
        role: "user",
        created: 2,
        content: [{ type: "text", text: "make it shorter" }],
        metadata: {
          userVisible: true,
          agentVisible: true,
          delivery: "steering",
        },
      },
    ]);
    useChatStore.getState().setStreamingMessageId("acp-session", "reply-1");
    useChatStore.getState().setPendingInterventionBoundary("acp-session", {
      interventionMessageId: "user-2",
    });

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "user-2",
        content: { type: "text", text: "make it shorter" },
        _meta: { distill: { messageId: "user-2", steer: true } },
      },
    } as never);
    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-2",
        title: "search",
        _meta: {
          distill: { messageId: "user-2", assistantMessageId: "reply-2" },
        },
      },
    } as never);
    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Shorter." },
        _meta: {
          distill: { messageId: "user-2", assistantMessageId: "reply-2" },
        },
      },
    } as never);
    flushBufferedStreamingUpdatesForSession("acp-session");

    const messages = useChatStore.getState().messagesBySession["acp-session"];
    expect(messages.map(({ id, role }) => ({ id, role }))).toEqual([
      { id: "reply-1", role: "assistant" },
      { id: "user-2", role: "user" },
      { id: "reply-2", role: "assistant" },
    ]);
    expect(messages[0].metadata?.completionStatus).toBe("completed");
    expect(messages[2].content.map((block) => block.type)).toEqual([
      "toolRequest",
      "text",
    ]);
    expect(
      useChatStore.getState().getSessionRuntime("acp-session")
        .streamingMessageId,
    ).toBe("reply-2");
  });

  it("starts a new reply when the host names one while an earlier reply is streaming", async () => {
    useChatStore.getState().setMessages("acp-session", [
      {
        id: "reply-1",
        role: "assistant",
        created: 1,
        content: [{ type: "text", text: "First answer" }],
        metadata: {
          userVisible: true,
          agentVisible: true,
          completionStatus: "inProgress",
        },
      },
    ]);
    useChatStore.getState().setStreamingMessageId("acp-session", "reply-1");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Second answer" },
        _meta: {
          distill: { messageId: "user-2", assistantMessageId: "reply-2" },
        },
      },
    } as never);
    flushBufferedStreamingUpdatesForSession("acp-session");

    expect(
      useChatStore.getState().messagesBySession["acp-session"],
    ).toMatchObject([
      {
        id: "reply-1",
        content: [{ type: "text", text: "First answer" }],
        metadata: { completionStatus: "completed" },
      },
      {
        id: "reply-2",
        content: [{ type: "text", text: "Second answer" }],
        metadata: { completionStatus: "inProgress" },
      },
    ]);
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
