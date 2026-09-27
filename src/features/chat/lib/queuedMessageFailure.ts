import { toast } from "sonner";
import { i18n } from "@/shared/i18n";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  type QueuedMessageRecord,
  useChatStore,
} from "@/features/chat/stores/chatStore";

/**
 * A queued prompt a background drain could not send stays first in its queue
 * (LAWS/CHAT.md), parked as failed so no drain attempts it again, and the
 * operator is told once. Left as it was, a prompt whose target cannot be
 * resolved (its project was archived, say) failed again on every start and
 * only ever reached the console.
 */
export function parkFailedQueuedMessage(
  sessionId: string,
  queuedMessage: QueuedMessageRecord,
): void {
  const current =
    useChatStore.getState().queuedMessageBySession[sessionId]?.[0];
  if (current !== queuedMessage) return;
  const message = i18n.t("chat:queue.backgroundSendFailed");
  useChatStore
    .getState()
    .deferTransportReadyMessage(sessionId, queuedMessage.recordId, {
      type: "workspace-first-send",
      status: "failed",
      error: message,
    });
  // Background drains only claim chats nobody is viewing, so a parked failure
  // would otherwise stay invisible until the chat is opened.
  const sessionTitle = useChatSessionStore
    .getState()
    .getSession(sessionId)
    ?.title?.trim();
  toast.error(sessionTitle || i18n.t("chat:queue.backgroundSendFailedTitle"), {
    description: message,
  });
}
