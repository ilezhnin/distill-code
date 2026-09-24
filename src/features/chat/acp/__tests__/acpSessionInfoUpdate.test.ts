import { beforeEach, describe, expect, it } from "vitest";
import { clearReplayBuffer } from "@/features/chat/hooks/replayBuffer";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { buildPersonaHandoffPreamble } from "@/shared/api/acpPersonaHandoff";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import { clearReplayAssistantTracking } from "../acpReplayAssistant";
import { handleSessionNotification } from "../acpNotificationHandler";

describe("ACP session info updates", () => {
  beforeEach(() => {
    clearReplayAssistantTracking();
    clearReplayBuffer("goose-session-replay-run");
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
      hasHydratedSessions: false,
      isRightRailOpen: false,
      activeWorkspaceBySession: {},
    });
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
  });

  it("ignores generated titles for user-named sessions", async () => {
    useChatSessionStore.getState().addSession({
      id: "goose-session-user-title",
      title: "My Custom Title",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messageCount: 0,
      userSetName: true,
    });

    await handleSessionNotification({
      sessionId: "goose-session-user-title",
      update: {
        sessionUpdate: "session_info_update",
        title: "Generated Test Title",
        updatedAt: "2026-01-01T00:01:00.000Z",
        _meta: {
          messageCount: 1,
          userSetName: true,
        },
      },
    } as never);

    expect(
      useChatSessionStore.getState().getSession("goose-session-user-title"),
    ).toMatchObject({
      title: "My Custom Title",
      updatedAt: "2026-01-01T00:01:00.000Z",
      messageCount: 1,
      userSetName: true,
    });
  });

  it("ignores bridge titles derived from the in-band persona handoff", async () => {
    useChatSessionStore.getState().addSession({
      id: "handoff-title-session",
      title: "New Chat",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messageCount: 0,
      userSetName: false,
    });

    await handleSessionNotification({
      sessionId: "handoff-title-session",
      update: {
        sessionUpdate: "session_info_update",
        title: buildPersonaHandoffPreamble("Be terse.").slice(0, 120),
        updatedAt: "2026-01-01T00:01:00.000Z",
      },
    } as never);

    expect(
      useChatSessionStore.getState().getSession("handoff-title-session"),
    ).toMatchObject({
      title: "New Chat",
      updatedAt: "2026-01-01T00:01:00.000Z",
    });
  });

  it("settles late idle stream state when the active run ends", async () => {
    const store = useChatStore.getState();
    store.setActiveRunId("goose-session-late-stream", "run-123");
    store.setRunCancellationPending("goose-session-late-stream", true);
    store.setStreamingMessageId("goose-session-late-stream", "assistant-late");
    store.setPendingInterventionBoundary("goose-session-late-stream", {
      interventionMessageId: "user-steer",
    });

    await handleSessionNotification({
      sessionId: "goose-session-late-stream",
      update: {
        sessionUpdate: "session_info_update",
        _meta: { activeRunId: null },
      },
    } as never);

    expect(
      useChatStore.getState().getSessionRuntime("goose-session-late-stream"),
    ).toMatchObject({
      chatState: "idle",
      activeRunId: null,
      isRunCancellationPending: false,
      streamingMessageId: null,
      pendingInterventionBoundary: null,
    });
  });
});
