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

type SessionInfoUpdate = SessionUpdate & {
  sessionUpdate: "session_info_update";
  title?: unknown;
  updatedAt?: unknown;
  meta?: unknown;
  _meta?: unknown;
};

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
  observeExecutionOwner(sessionId, meta.executionOwner);
  const ownedTask = taskBindingId(sessionId) !== null;
  if ("activeRunId" in meta) {
    const activeRunId =
      typeof meta.activeRunId === "string" ? meta.activeRunId : null;
    const chatStore = useChatStore.getState();
    if (activeRunId === null && !ownedTask) {
      flushBufferedStreamingUpdatesForSession(sessionId, {
        flushSubtitle: true,
      });
      completeReplayAssistantMessage(sessionId);
      chatStore.settleActiveRun(sessionId);
    } else if (activeRunId !== null) {
      chatStore.setActiveRunId(sessionId, activeRunId);
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
