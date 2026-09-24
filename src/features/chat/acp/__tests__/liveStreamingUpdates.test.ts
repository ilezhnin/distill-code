import { beforeEach, describe, expect, it } from "vitest";
import {
  clearBufferedStreamingUpdatesForSession,
  clearLiveSubtitleUpdate,
  clearStreamingMessageOwners,
  enqueueStreamingTextUpdate,
  enqueueStreamingThinkingUpdate,
  enqueueStreamingTerminalUpdate,
  flushAllBufferedStreamingUpdates,
  releaseStreamingMessageOwner,
} from "../liveStreamingUpdates";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  claimSessionPrompt,
  releaseSessionPrompt,
} from "@/features/chat/lib/sessionPromptOwnership";
import type { Message } from "@/shared/types/messages";

const sessionId = "acp-session";

function seedSession(): ChatSession {
  return {
    id: sessionId,
    title: "Test Session",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    messageCount: 0,
  };
}

function makeAssistantMessage(id = "assistant-1"): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [],
    metadata: { userVisible: true, completionStatus: "inProgress" },
  };
}

describe("liveStreamingUpdates", () => {
  beforeEach(() => {
    clearLiveSubtitleUpdate(sessionId);
    clearStreamingMessageOwners();
    clearBufferedStreamingUpdatesForSession(sessionId);
    useChatStore.setState({ messagesBySession: {}, sessionStateById: {} });
    useChatSessionStore.setState({
      sessions: [seedSession()],
      activeSessionId: null,
      isLoading: false,
      hasHydratedSessions: true,
      isRightRailOpen: false,
      activeWorkspaceBySession: {},
    });
  });

  it("keeps late terminal output on its owning message without moving the active stream", () => {
    claimSessionPrompt(sessionId);
    const older = makeAssistantMessage("older");
    older.content = [
      {
        type: "toolRequest",
        id: "cmd",
        name: "Run",
        arguments: {},
        status: "in_progress",
      },
    ];
    useChatStore
      .getState()
      .setMessages(sessionId, [older, makeAssistantMessage("current")]);
    useChatStore.getState().setStreamingMessageId(sessionId, "current");
    enqueueStreamingTerminalUpdate(sessionId, "older", "cmd", "one\n");
    enqueueStreamingTextUpdate(sessionId, "current", "answer");
    enqueueStreamingTerminalUpdate(sessionId, "older", "cmd", "two\n");
    flushAllBufferedStreamingUpdates();
    expect(
      useChatStore.getState().messagesBySession[sessionId][0].content[0],
    ).toMatchObject({ terminalOutput: "one\ntwo\n", status: "in_progress" });
    expect(
      useChatStore.getState().getSessionRuntime(sessionId).streamingMessageId,
    ).toBe("current");
    enqueueStreamingTerminalUpdate(sessionId, "older", "cmd", "discarded");
    clearBufferedStreamingUpdatesForSession(sessionId);
    flushAllBufferedStreamingUpdates();
    expect(
      useChatStore.getState().messagesBySession[sessionId][0].content[0],
    ).toMatchObject({ terminalOutput: "one\ntwo\n" });
  });

  // A prompt that settles while the host keeps streaming (a rejected
  // `session/prompt` does not stop the bridge) used to strand the rest of the
  // reply: every later chunk was buffered under the released owner symbol,
  // which no flush can match, so it was never rendered and never freed.
  it("renders chunks that arrive after the owning prompt was released", () => {
    const owner = claimSessionPrompt(sessionId);
    useChatStore.getState().setMessages(sessionId, [makeAssistantMessage()]);
    useChatStore.getState().setStreamingMessageId(sessionId, "assistant-1");
    enqueueStreamingTextUpdate(sessionId, "assistant-1", "before");
    flushAllBufferedStreamingUpdates();

    releaseSessionPrompt(sessionId, owner);
    releaseStreamingMessageOwner(sessionId, owner);

    enqueueStreamingTextUpdate(sessionId, "assistant-1", " after");
    enqueueStreamingThinkingUpdate(
      sessionId,
      "assistant-1",
      "trailing thought",
    );
    flushAllBufferedStreamingUpdates();

    expect(
      useChatStore.getState().messagesBySession[sessionId]?.[0]?.content,
    ).toEqual([
      { type: "text", text: "before after" },
      { type: "thinking", text: "trailing thought" },
    ]);
    // And every further chunk keeps flowing, rather than piling up for a flush
    // that can never match.
    enqueueStreamingTextUpdate(sessionId, "assistant-1", "!");
    flushAllBufferedStreamingUpdates();
    expect(
      useChatStore
        .getState()
        .messagesBySession[sessionId]?.[0]?.content?.at(-1),
    ).toEqual({ type: "text", text: "!" });
  });
});
