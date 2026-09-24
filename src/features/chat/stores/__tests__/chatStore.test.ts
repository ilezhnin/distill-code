import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/shared/types/messages";
import { useChatStore } from "../chatStore";
import { loadCachedDrafts } from "../draftPersistence";
import { loadCachedUnreadSessionIds } from "../unreadPersistence";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    created: Date.now(),
    content: [{ type: "text", text: "hello" }],
    metadata: { userVisible: true },
    ...overrides,
  };
}

function getRuntime(sessionId: string) {
  return useChatStore.getState().getSessionRuntime(sessionId);
}

describe("chatStore", () => {
  beforeEach(() => {
    window.localStorage.removeItem("distill:unread-sessions");
    window.localStorage.removeItem("distill:chat-message-queues:v1");
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      nonEmptyDraftSessionIds: new Set(),
      skillDraftsBySession: {},
      draftAttachmentsBySession: {},
      activeSessionId: null,
      recentMessageSessionIds: [],
      isViewingActiveSession: false,
      isConnected: false,
      loadingSessionIds: new Set(),
      scrollTargetMessageBySession: {},
    });
  });

  it("does not evict inactive messages for a running session", () => {
    useChatStore.getState().setActiveSession("running");
    useChatStore
      .getState()
      .setMessages("running", [makeMessage({ id: "running-message" })]);
    useChatStore.getState().setStreamingMessageId("running", "running-message");
    useChatStore.getState().setChatState("running", "streaming");

    for (let index = 1; index <= 11; index += 1) {
      const sessionId = `s${index}`;
      useChatStore.getState().setActiveSession(sessionId);
      useChatStore
        .getState()
        .setMessages(sessionId, [makeMessage({ id: `message-${index}` })]);
    }

    expect(useChatStore.getState().messagesBySession.running).toHaveLength(1);
  });

  it("appends streamed text only within the targeted session", () => {
    const streaming = makeMessage({
      id: "stream-1",
      content: [{ type: "text", text: "" }],
    });

    useChatStore.getState().setMessages("s1", [streaming]);
    useChatStore.getState().setStreamingMessageId("s1", "stream-1");
    useChatStore.getState().updateStreamingText("s1", "Hello");
    useChatStore.getState().updateStreamingText("s1", " world");

    const updated = useChatStore.getState().messagesBySession.s1[0];
    expect(updated.content[0]).toEqual({ type: "text", text: "Hello world" });
    expect(getRuntime("s2").streamingMessageId).toBeNull();
  });

  it("inserts a continuation assistant after a contiguous delivered steer batch", () => {
    const store = useChatStore.getState();
    store.setMessages("s1", [
      makeMessage({
        id: "assistant-before-steer",
        role: "assistant",
        created: 1,
        content: [{ type: "text", text: "First answer" }],
        metadata: {
          userVisible: true,
          agentVisible: true,
          completionStatus: "inProgress",
        },
      }),
      makeMessage({
        id: "steer-1",
        role: "user",
        created: 2,
        content: [{ type: "text", text: "first steer" }],
        metadata: { userVisible: true, delivery: "steer" },
      }),
      makeMessage({
        id: "steer-2",
        role: "user",
        created: 2,
        content: [{ type: "text", text: "second steer" }],
        metadata: { userVisible: true, delivery: "steer" },
      }),
    ]);
    store.setStreamingMessageId("s1", "assistant-before-steer");
    store.setPendingInterventionBoundary("s1", {
      interventionMessageId: "steer-1",
    });

    store.startAssistantStreamAfterIntervention("s1");
    store.updateStreamingText("s1", "Second answer");

    const messages = useChatStore.getState().messagesBySession.s1;
    expect(messages.map((message) => message.id)).toEqual([
      "assistant-before-steer",
      "steer-1",
      "steer-2",
      messages[3].id,
    ]);
    expect(messages[0].metadata?.completionStatus).toBe("completed");
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Second answer" }],
      metadata: { completionStatus: "inProgress" },
    });
    expect(getRuntime("s1").streamingMessageId).toBe(messages[3].id);
    expect(getRuntime("s1").pendingInterventionBoundary).toBeNull();
  });

  it("transitions a session to error without affecting another session", () => {
    const store = useChatStore.getState();

    store.setChatState("s1", "streaming");
    store.setChatState("s2", "thinking");
    store.setError("s1", "boom");

    expect(getRuntime("s1").chatState).toBe("error");
    expect(getRuntime("s1").error).toBe("boom");
    expect(getRuntime("s2").chatState).toBe("thinking");
    expect(getRuntime("s2").error).toBeNull();
  });

  function replyWithAnOpenToolCall(): Message {
    return {
      id: "reply-1",
      role: "assistant",
      created: 1,
      content: [
        {
          type: "toolRequest",
          id: "tool-1",
          name: "Edit agent_skills.rs",
          arguments: {},
          status: "in_progress",
          startedAt: 1,
        },
      ],
      metadata: { userVisible: true, agentVisible: true },
    };
  }

  function toolCallStatus(sessionId: string): string | undefined {
    const block =
      useChatStore.getState().messagesBySession[sessionId]?.[0]?.content[0];
    return block?.type === "toolRequest" ? block.status : undefined;
  }

  it("stops the tool calls a settled run left running, in the same write", () => {
    const store = useChatStore.getState();
    store.setMessages("s1", [replyWithAnOpenToolCall()]);
    store.setActiveRunId("s1", "run-1");

    let writes = 0;
    const unsubscribe = useChatStore.subscribe(() => {
      writes += 1;
    });
    store.settleActiveRun("s1");
    unsubscribe();

    expect(writes).toBe(1);
    expect(toolCallStatus("s1")).toBe("stopped");
  });

  it("leaves the calls of a chat that is already streaming its next turn", () => {
    const store = useChatStore.getState();
    store.setMessages("s1", [replyWithAnOpenToolCall()]);
    store.setChatState("s1", "streaming");
    store.setActiveRunId("s1", "run-1");

    store.settleActiveRun("s1");

    expect(toolCallStatus("s1")).toBe("in_progress");
  });

  it("promotes all local chat state to a real ACP session id", () => {
    const message = makeMessage({ id: "message-1" });
    const store = useChatStore.getState();

    store.setActiveSession("local-session");
    store.setMessages("local-session", [message]);
    store.setChatState("local-session", "thinking");
    store.setDraft("local-session", "draft text");
    store.setSkillDrafts("local-session", [{ id: "skill-1", name: "Skill" }]);
    const queuedAttachment = {
      id: "queued-attachment-1",
      kind: "file" as const,
      name: "queued-notes.txt",
      path: "/tmp/queued-notes.txt",
    };
    const queuedSendOptions = {
      assistantPrompt: "Use these skills for this request: code-review.",
      displayText: "@Reviewer queued text",
      chips: [
        {
          id: "reviewer",
          label: "Reviewer",
          agentRole: "active" as const,
          type: "agent" as const,
        },
        { label: "code-review", type: "skill" as const },
      ],
    };
    store.setDraftAttachments("local-session", [
      {
        id: "attachment-1",
        kind: "file",
        name: "report.pdf",
        path: "/tmp/report.pdf",
      },
    ]);
    store.enqueueTransportReadyMessage("local-session", {
      persona: { kind: "persona", id: "reviewer" },
      text: "@Reviewer queued text",
      attachments: [queuedAttachment],
      sendOptions: queuedSendOptions,
    });
    store.setSessionLoading("local-session", true);
    store.setScrollTargetMessage("local-session", "message-1", "query");

    store.promoteSessionId("local-session", "acp-session");

    const state = useChatStore.getState();
    expect(state.activeSessionId).toBe("acp-session");
    expect(state.messagesBySession["acp-session"]).toEqual([message]);
    expect(state.messagesBySession["local-session"]).toBeUndefined();
    expect(state.sessionStateById["acp-session"].chatState).toBe("thinking");
    expect(state.sessionStateById["local-session"]).toBeUndefined();
    expect(state.draftsBySession["acp-session"]).toBe("draft text");
    expect(state.draftsBySession["local-session"]).toBeUndefined();
    expect(state.skillDraftsBySession["acp-session"]).toEqual([
      { id: "skill-1", name: "Skill" },
    ]);
    expect(state.draftAttachmentsBySession["acp-session"]).toEqual([
      {
        id: "attachment-1",
        kind: "file",
        name: "report.pdf",
        path: "/tmp/report.pdf",
      },
    ]);
    expect(state.draftAttachmentsBySession["local-session"]).toBeUndefined();
    expect(state.queuedMessageBySession["acp-session"]?.[0]?.payload).toEqual({
      persona: { kind: "persona", id: "reviewer" },
      text: "@Reviewer queued text",
      attachments: [queuedAttachment],
      sendOptions: queuedSendOptions,
    });
    expect(state.loadingSessionIds.has("acp-session")).toBe(true);
    expect(state.loadingSessionIds.has("local-session")).toBe(false);
    expect(state.scrollTargetMessageBySession["acp-session"]).toEqual({
      messageId: "message-1",
      query: "query",
    });
  });

  it("updates and removes queue records by stable ID without reordering", () => {
    const store = useChatStore.getState();
    store.enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "first",
    });
    store.enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "second",
    });
    store.enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "third",
    });
    const queue = useChatStore.getState().queuedMessageBySession.s1 ?? [];

    expect(
      store.updateQueuedMessage("s1", queue[1].recordId, {
        persona: { kind: "inherit" },
        text: "edited",
      }),
    ).toBe(true);
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.map((record) => ({
        id: record.recordId,
        text: record.payload.text,
      })),
    ).toEqual([
      { id: queue[0].recordId, text: "first" },
      { id: queue[1].recordId, text: "edited" },
      { id: queue[2].recordId, text: "third" },
    ]);

    store.dismissQueuedMessage("s1", queue[1].recordId);
    expect(
      useChatStore
        .getState()
        .queuedMessageBySession.s1?.map((record) => record.payload.text),
    ).toEqual(["first", "third"]);
  });

  it("preserves an edit lock through defer and release", () => {
    const store = useChatStore.getState();
    store.enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "original",
    });
    const recordId =
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.recordId ?? "";

    expect(store.setQueuedMessageEditing("s1", recordId, true)).toBe(true);
    expect(
      store.deferTransportReadyMessage("s1", recordId, {
        type: "workspace-first-send",
        status: "creating",
      }),
    ).toBe(true);
    expect(store.releaseDeferredMessage("s1", recordId)).toBe(true);
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({
      kind: "transport-ready",
      recordId,
      payload: { text: "original" },
      editing: true,
    });
  });

  it("parks interrupted workspace creation, clears edit locks, and restores targetless transport records", async () => {
    window.localStorage.setItem(
      "distill:chat-message-queues:v1",
      JSON.stringify({
        s1: [
          {
            kind: "deferred",
            recordId: "workspace",
            payload: { text: "build it" },
            editing: true,
            state: {
              type: "workspace-first-send",
              status: "creating",
              projectId: "project-1",
              desired: [],
            },
          },
          {
            kind: "transport-ready",
            recordId: "tail",
            payload: { text: "after setup" },
          },
        ],
      }),
    );

    vi.resetModules();
    const { useChatStore: freshChatStore } = await import("../chatStore");
    const queue = freshChatStore.getState().queuedMessageBySession.s1 ?? [];

    expect(queue).toHaveLength(2);
    expect(queue[0]).not.toHaveProperty("editing");
    expect(queue[0]).toMatchObject({
      kind: "deferred",
      recordId: "workspace",
      restored: true,
      state: {
        type: "workspace-first-send",
        status: "held",
      },
    });
    expect(queue[1]).toMatchObject({
      kind: "transport-ready",
      recordId: "tail",
      restored: true,
      payload: {
        text: "after setup",
        persona: { kind: "inherit" },
      },
    });
  });

  it("persists queue changes for restart recovery", () => {
    const store = useChatStore.getState();
    store.enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "durable",
    });
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    expect(
      JSON.parse(
        window.localStorage.getItem("distill:chat-message-queues:v1") ?? "{}",
      ),
    ).toMatchObject({
      s1: [{ recordId: record?.recordId, payload: { text: "durable" } }],
    });

    store.dismissQueuedMessage("s1", record?.recordId);
    expect(
      window.localStorage.getItem("distill:chat-message-queues:v1"),
    ).toBeNull();
  });

  it("appends promoted records after an occupied destination queue", () => {
    const store = useChatStore.getState();
    store.enqueueTransportReadyMessage("acp-session", {
      persona: { kind: "inherit" },
      text: "existing",
    });
    store.enqueueTransportReadyMessage("local-session", {
      persona: { kind: "inherit" },
      text: "promoted-1",
    });
    store.enqueueTransportReadyMessage("local-session", {
      persona: { kind: "inherit" },
      text: "promoted-2",
    });

    store.promoteSessionId("local-session", "acp-session");

    expect(
      useChatStore
        .getState()
        .queuedMessageBySession["acp-session"]?.map(
          (record) => record.payload.text,
        ),
    ).toEqual(["existing", "promoted-1", "promoted-2"]);
    expect(
      useChatStore.getState().queuedMessageBySession["local-session"],
    ).toBeUndefined();
  });

  it("moves one record without disturbing either queue", () => {
    const store = useChatStore.getState();
    store.enqueueTransportReadyMessage("pending", {
      persona: { kind: "inherit" },
      text: "first",
    });
    store.enqueueTransportReadyMessage("pending", {
      persona: { kind: "inherit" },
      text: "second",
    });
    store.enqueueDeferredMessage(
      "session-1",
      { persona: { kind: "inherit" }, text: "existing deferred" },
      { type: "workspace-first-send", status: "held" },
    );
    const movedId =
      useChatStore.getState().queuedMessageBySession.pending?.[0]?.recordId ??
      "";

    expect(store.moveQueuedMessage("pending", "session-1", movedId)).toBe(true);
    expect(
      useChatStore
        .getState()
        .queuedMessageBySession.pending?.map((record) => record.payload.text),
    ).toEqual(["second"]);
    expect(
      useChatStore
        .getState()
        .queuedMessageBySession["session-1"]?.map(
          (record) => record.payload.text,
        ),
    ).toEqual(["existing deferred", "first"]);

    expect(store.moveQueuedMessage("session-1", "pending", movedId)).toBe(true);
    expect(
      useChatStore
        .getState()
        .queuedMessageBySession["session-1"]?.map(
          (record) => record.payload.text,
        ),
    ).toEqual(["existing deferred"]);
    expect(
      useChatStore
        .getState()
        .queuedMessageBySession.pending?.map((record) => record.payload.text),
    ).toEqual(["second", "first"]);
  });

  it("removes session data during cleanup including queued messages and drafts", () => {
    const store = useChatStore.getState();

    store.addMessage("s1", makeMessage());
    store.setChatState("s1", "streaming");
    store.enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "queued",
    });
    store.setDraft("s1", "draft text");
    store.setSkillDrafts("s1", [{ id: "skill-1", name: "code-review" }]);
    store.setDraftAttachments("s1", [
      {
        id: "attachment-1",
        kind: "file",
        name: "report.pdf",
        path: "/tmp/report.pdf",
      },
    ]);
    store.markSessionUnread("s1");
    store.markSessionUnread("s2");
    store.setActiveSession("s1");
    store.cleanupSession("s1");

    const state = useChatStore.getState();
    expect(state.messagesBySession.s1).toBeUndefined();
    expect(state.sessionStateById.s1).toBeUndefined();
    expect(state.queuedMessageBySession.s1).toBeUndefined();
    expect(state.draftsBySession.s1).toBeUndefined();
    expect(useChatStore.getState().skillDraftsBySession.s1).toBeUndefined();
    expect(
      useChatStore.getState().draftAttachmentsBySession.s1,
    ).toBeUndefined();
    expect(store.activeSessionId).toBeNull();
    expect(loadCachedUnreadSessionIds()).toEqual(["s2"]);
  });
});

describe("chatStore draft localStorage persistence", () => {
  const STORAGE_KEY = "distill:chat-drafts";

  beforeEach(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      nonEmptyDraftSessionIds: new Set(),
      skillDraftsBySession: {},
      draftAttachmentsBySession: {},
      activeSessionId: null,
      recentMessageSessionIds: [],
      isViewingActiveSession: false,
      isConnected: false,
    });
  });

  afterEach(() => {
    window.localStorage.removeItem(STORAGE_KEY);
  });

  it("removes draft from localStorage on cleanupSession", () => {
    useChatStore.getState().setDraft("s1", "hello");
    useChatStore.getState().setDraft("s2", "world");
    useChatStore.getState().cleanupSession("s1");

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored).toEqual({ s2: "world" });
  });

  it("preserves other session drafts when one is cleared", () => {
    useChatStore.getState().setDraft("s1", "hello");
    useChatStore.getState().setDraft("s2", "world");
    useChatStore.getState().clearDraft("s1");

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored).toEqual({ s2: "world" });
  });

  it("ignores malformed cached draft values", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ s1: "hello", s2: null, s3: 42, s4: false }),
    );

    expect(loadCachedDrafts()).toEqual({ s1: "hello" });
  });
});
