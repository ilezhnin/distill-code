import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearBufferedStreamingUpdatesForSession,
  clearLiveSubtitleUpdate,
  clearStreamingMessageOwners,
  enqueueStreamingTextUpdate,
  enqueueStreamingThinkingUpdate,
  enqueueStreamingTerminalUpdate,
  flushAllBufferedStreamingUpdates,
  registerStreamingMessageOwner,
  releaseStreamingMessageOwner,
  releaseStreamingSession,
  scheduleLiveSubtitleUpdate,
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

  describe("per-session bookkeeping", () => {
    function contentOf(messageId: string) {
      return useChatStore
        .getState()
        .messagesBySession[sessionId]?.find(
          (message) => message.id === messageId,
        )?.content;
    }

    function subtitle() {
      return useChatSessionStore.getState().getSession(sessionId)?.subtitle;
    }

    it("keeps a message bound to the prompt it began under while it is recent", () => {
      const first = claimSessionPrompt(sessionId);
      useChatStore
        .getState()
        .setMessages(sessionId, [makeAssistantMessage("oldest")]);
      registerStreamingMessageOwner(sessionId, "oldest");
      for (let index = 0; index < 8; index += 1) {
        registerStreamingMessageOwner(sessionId, `newer-${index}`);
      }
      releaseSessionPrompt(sessionId, first);
      claimSessionPrompt(sessionId);

      enqueueStreamingTextUpdate(sessionId, "oldest", "late");
      flushAllBufferedStreamingUpdates();

      // Still the first prompt's: held back rather than applied as the
      // current prompt's stream.
      expect(contentOf("oldest")).toEqual([]);
    });

    it("binds a message that fell out of the per-session window to the prompt that owns the chat now", () => {
      const first = claimSessionPrompt(sessionId);
      useChatStore
        .getState()
        .setMessages(sessionId, [makeAssistantMessage("oldest")]);
      registerStreamingMessageOwner(sessionId, "oldest");
      for (let index = 0; index < 64; index += 1) {
        registerStreamingMessageOwner(sessionId, `newer-${index}`);
      }
      releaseSessionPrompt(sessionId, first);
      claimSessionPrompt(sessionId);

      enqueueStreamingTextUpdate(sessionId, "oldest", "late");
      flushAllBufferedStreamingUpdates();

      expect(contentOf("oldest")).toEqual([{ type: "text", text: "late" }]);
    });

    it("forgets a released session's bindings", () => {
      const first = claimSessionPrompt(sessionId);
      useChatStore
        .getState()
        .setMessages(sessionId, [makeAssistantMessage("reply")]);
      registerStreamingMessageOwner(sessionId, "reply");
      releaseSessionPrompt(sessionId, first);
      claimSessionPrompt(sessionId);

      releaseStreamingSession(sessionId);
      enqueueStreamingTextUpdate(sessionId, "reply", "trailing");
      flushAllBufferedStreamingUpdates();

      expect(contentOf("reply")).toEqual([{ type: "text", text: "trailing" }]);
    });

    it("publishes a throttled subtitle at once when the session is released", () => {
      vi.useFakeTimers();
      try {
        scheduleLiveSubtitleUpdate(sessionId, "First words");
        scheduleLiveSubtitleUpdate(sessionId, "First words and more");
        expect(subtitle()).toBe("First words");

        releaseStreamingSession(sessionId);
        expect(subtitle()).toBe("First words and more");

        // Nothing is left waiting to publish over a later subtitle.
        useChatSessionStore
          .getState()
          .patchSession(sessionId, { subtitle: "Renamed" });
        vi.runAllTimers();
        expect(subtitle()).toBe("Renamed");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not publish an already published subtitle again on release", () => {
      scheduleLiveSubtitleUpdate(sessionId, "Streamed words");
      useChatSessionStore
        .getState()
        .patchSession(sessionId, { subtitle: "Newer subtitle" });

      releaseStreamingSession(sessionId);

      expect(subtitle()).toBe("Newer subtitle");
    });
  });
});
