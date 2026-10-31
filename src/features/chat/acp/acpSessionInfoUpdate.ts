import { useBackgroundTasksStore } from "../stores/backgroundTasksStore";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { syncConductorDisplayNameFromTitle } from "@/features/conductor/syncConductorDisplayName";
import { isPersonaHandoffText } from "@/shared/api/acpPersonaHandoff";
import { completeReplayAssistantMessage } from "./acpReplayAssistant";
import { flushBufferedStreamingUpdatesForSession } from "./liveStreamingUpdates";
import { isRecord } from "@/shared/lib/isRecord";
import {
  observeExecutionOwner,
  taskBindingId,
} from "../lib/executionOwnership";
import { reconcileOwnedTaskSession } from "../lib/ownedTaskDispatch";
import { completeAssistantMessage } from "@/features/chat/lib/messageCompletion";
import { isSessionRunning } from "../lib/sessionActivity";
import {
  adoptSessionRun,
  adoptedSessionRun,
  forgetAdoptedSessionRun,
} from "../lib/sessionPromptOwnership";

type SessionInfoUpdate = SessionUpdate & {
  sessionUpdate: "session_info_update";
  title?: unknown;
  updatedAt?: unknown;
  meta?: unknown;
  _meta?: unknown;
};

/** The reason of a `turnFailed` record, or null when the meta carries none. */
function failedTurnReason(value: unknown): string | null {
  if (!isRecord(value) || typeof value.reason !== "string") return null;
  const reason = value.reason.trim();
  return reason || null;
}

export function handleSessionInfoUpdate(
  sessionId: string,
  update: SessionUpdate,
): void {
  const info = update as SessionInfoUpdate;
  const sessionStore = useChatSessionStore.getState();
  const meta = isRecord(info._meta)
    ? info._meta
    : isRecord(info.meta)
      ? info.meta
      : {};
  if ("backgroundTasks" in meta)
    useBackgroundTasksStore.getState().replace(sessionId, meta.backgroundTasks);
  observeExecutionOwner(sessionId, meta.executionOwner);
  const ownedTask = taskBindingId(sessionId) !== null;
  if (meta.backgroundDisconnected === true && !ownedTask) {
    flushBufferedStreamingUpdatesForSession(sessionId, { flushSubtitle: true });
    const store = useChatStore.getState();
    const messageId = store.getSessionRuntime(sessionId).streamingMessageId;
    if (messageId)
      store.updateMessage(sessionId, messageId, (message) => ({
        ...message,
        metadata: { ...message.metadata, completionStatus: "error" },
      }));
    store.setChatState(sessionId, "idle");
  }
  const turnFailure = failedTurnReason(meta.turnFailed);
  if (turnFailure && !ownedTask) {
    // The host's record that the turn failed after it produced something
    // (`turn_failed_update`). Live, the prompt's own reply says the same to
    // the sender; on a replay this is the only word of it, so the reply is
    // marked here, with the reason the bubble shows under it, and the chat
    // parks in error the way the live failure parks it.
    flushBufferedStreamingUpdatesForSession(sessionId, { flushSubtitle: true });
    const store = useChatStore.getState();
    const messageId = store.getSessionRuntime(sessionId).streamingMessageId;
    if (messageId)
      store.updateMessage(sessionId, messageId, (message) => ({
        ...message,
        metadata: {
          ...message.metadata,
          completionStatus: "error",
          failureReason: turnFailure,
        },
      }));
    store.setError(sessionId, turnFailure);
  }
  if ("activeRunId" in meta) {
    const activeRunId =
      typeof meta.activeRunId === "string" ? meta.activeRunId : null;
    const chatStore = useChatStore.getState();
    if (activeRunId === null && !ownedTask) {
      flushBufferedStreamingUpdatesForSession(sessionId, {
        flushSubtitle: true,
      });
      if (adoptedSessionRun(sessionId)) {
        // The host settled a turn this renderer only adopted (see the
        // notification handler): the reply is complete and the chat is idle
        // again, which no local prompt is left to say.
        const messageId =
          chatStore.getSessionRuntime(sessionId).streamingMessageId;
        if (messageId)
          chatStore.updateMessage(
            sessionId,
            messageId,
            completeAssistantMessage,
          );
        forgetAdoptedSessionRun(sessionId);
        chatStore.setChatState(sessionId, "idle");
      }
      completeReplayAssistantMessage(sessionId);
      chatStore.settleActiveRun(sessionId);
    } else if (activeRunId !== null) {
      chatStore.setActiveRunId(sessionId, activeRunId);
      if (
        !ownedTask &&
        adoptSessionRun(sessionId, activeRunId) &&
        !isSessionRunning(chatStore.getSessionRuntime(sessionId).chatState)
      ) {
        // The host names a run of this chat that no prompt here owns (the
        // chat was loaded while it ran): running, with Stop, until settled.
        chatStore.setChatState(sessionId, "streaming");
      }
    }
  }
  if (ownedTask) void reconcileOwnedTaskSession(sessionId);

  const session = sessionStore.getSession(sessionId);
  if (!session) {
    return;
  }

  const patch: Parameters<typeof sessionStore.patchSession>[1] = {};
  if (typeof meta.accountId === "string" || meta.accountId === null) {
    patch.accountId = meta.accountId;
  }

  if (
    typeof info.title === "string" &&
    info.title &&
    !session.userSetName &&
    !isPersonaHandoffText(info.title)
  ) {
    patch.title = info.title;
  }
  if (typeof info.updatedAt === "string" && info.updatedAt) {
    patch.updatedAt = info.updatedAt;
  }
  if (typeof meta.messageCount === "number") {
    patch.messageCount = meta.messageCount;
  }
  if (typeof meta.lastMessageAt === "string" && meta.lastMessageAt) {
    patch.lastMessageAt = meta.lastMessageAt;
  }
  if (typeof meta.userSetName === "boolean") {
    patch.userSetName = meta.userSetName;
  }

  if (Object.keys(patch).length > 0) {
    sessionStore.patchSession(sessionId, patch);
  }
  if (typeof patch.title === "string") {
    syncConductorDisplayNameFromTitle(sessionId, patch.title);
  }
}
