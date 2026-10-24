import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../../stores/chatStore";
import { useBackgroundTasksStore } from "../../stores/backgroundTasksStore";
import {
  clearMessageTracking,
  handleSessionNotification,
} from "../acpNotificationHandler";
import { flushBufferedStreamingUpdatesForSession } from "../liveStreamingUpdates";
import {
  claimSessionPrompt,
  ownsSessionPrompt,
  getSessionPromptOwner,
  releaseSessionPrompt,
} from "../../lib/sessionPromptOwnership";

vi.mock("@/features/chat/lib/ownedTaskDispatch", () => ({
  reconcileOwnedTaskSession: vi.fn(async () => false),
}));

const sessionId = "background-example";
const meta = (finished = false) => ({
  distill: {
    messageId: "user",
    assistantMessageId: "followup",
    runId: "background-run",
    autonomous: true,
    autonomousFinished: finished,
  },
});
const send = (update: Record<string, unknown>) =>
  handleSessionNotification({ sessionId, update } as never);

describe("ordinary chat background work", () => {
  beforeEach(() => {
    clearMessageTracking();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      loadingSessionIds: new Set(),
    });
    useBackgroundTasksStore.setState({ bySession: {} });
  });

  it("shows and completes an autonomous reply after the user prompt has already returned", async () => {
    useChatStore.getState().addMessage(sessionId, {
      id: "foreground",
      role: "assistant",
      created: 1,
      content: [{ type: "text", text: "Packing in the background." }],
      metadata: {
        completionStatus: "completed",
        userVisible: true,
        agentVisible: true,
      },
    });
    await send({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Check the output" },
      _meta: meta(),
    });
    await send({
      sessionUpdate: "tool_call",
      toolCallId: "verify",
      title: "Verify archive",
      status: "in_progress",
      _meta: meta(),
    });
    expect(useChatStore.getState().getSessionRuntime(sessionId).chatState).toBe(
      "streaming",
    );
    await send({
      sessionUpdate: "tool_call_update",
      toolCallId: "verify",
      status: "completed",
      _meta: meta(),
    });
    await send({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Archive verified." },
      _meta: meta(),
    });
    await send({
      sessionUpdate: "usage_update",
      used: 10,
      size: 1000,
      _meta: meta(true),
    });
    const state = useChatStore.getState();
    expect(state.getSessionRuntime(sessionId).chatState).toBe("idle");
    expect(state.getSessionRuntime(sessionId).activeRunId).toBeNull();
    const messages = state.messagesBySession[sessionId];
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toEqual([
      { type: "text", text: "Packing in the background." },
    ]);
    expect(messages[1].id).toBe("followup");
    expect(messages[1].metadata?.completionStatus).toBe("completed");
    expect(messages[1].content).toContainEqual({
      type: "text",
      text: "Archive verified.",
    });
  });

  it("keeps task status independently of a finished prompt and accepts terminal updates", async () => {
    await send({
      sessionUpdate: "session_info_update",
      _meta: {
        backgroundTasks: [
          { id: "pack", state: "running", description: "Pack archive" },
        ],
      },
    });
    await send({
      sessionUpdate: "session_info_update",
      _meta: { activeRunId: null },
    });
    expect(
      useBackgroundTasksStore.getState().bySession[sessionId][0].state,
    ).toBe("running");
    await send({
      sessionUpdate: "session_info_update",
      _meta: {
        backgroundTasks: [
          { id: "pack", state: "completed", summary: "Exit 0" },
        ],
      },
    });
    expect(
      useBackgroundTasksStore.getState().bySession[sessionId][0].state,
    ).toBe("completed");
    // A newly attached runtime authoritatively clears a dead process's tasks.
    await send({
      sessionUpdate: "session_info_update",
      _meta: { backgroundTasks: [] },
    });
    expect(useBackgroundTasksStore.getState().bySession[sessionId]).toEqual([]);
  });

  it("replays autonomous chunks without restarting live activity", async () => {
    useChatStore.setState({ loadingSessionIds: new Set([sessionId]) });
    await send({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Saved completion" },
      _meta: meta(),
    });
    await send({
      sessionUpdate: "usage_update",
      used: 10,
      size: 1000,
      _meta: meta(true),
    });
    flushBufferedStreamingUpdatesForSession(sessionId);
    expect(
      useChatStore.getState().getSessionRuntime(sessionId).activeRunId,
    ).toBeNull();
  });

  it("transfers ownership before an older foreground request can settle the follow-up", async () => {
    const foreground = claimSessionPrompt(sessionId);
    await send({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Follow-up" },
      _meta: meta(),
    });
    expect(ownsSessionPrompt(sessionId, foreground)).toBe(false);
    expect(releaseSessionPrompt(sessionId, foreground)).toBe(false);
    expect(useChatStore.getState().getSessionRuntime(sessionId).chatState).toBe(
      "streaming",
    );
    const autonomous = getSessionPromptOwner(sessionId);
    if (!autonomous) throw new Error("Missing autonomous stream owner");
    releaseSessionPrompt(sessionId, autonomous);
    useChatStore.getState().setChatState(sessionId, "idle");
    await send({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Stale after cancellation" },
      _meta: meta(),
    });
    expect(useChatStore.getState().getSessionRuntime(sessionId).chatState).toBe(
      "idle",
    );
  });
});
