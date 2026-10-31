import { toast } from "sonner";
import { i18n } from "@/shared/i18n";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  type QueuedMessageRecord,
  useChatStore,
} from "@/features/chat/stores/chatStore";
import type { DeferredWorkspaceSend } from "@/features/chat/lib/firstWorkspaceSend";

function notifyParkedSend(sessionId: string, message: string): void {
  const sessionTitle = useChatSessionStore
    .getState()
    .getSession(sessionId)
    ?.title?.trim();
  toast.error(sessionTitle || i18n.t("chat:queue.backgroundSendFailedTitle"), {
    description: message,
  });
}

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
  notifyParkedSend(sessionId, message);
}

/**
 * A prompt the host withdrew from its session's history (the provider refused
 * it before the agent did anything) goes back first in its queue (LAWS/CHAT.md),
 * parked with the error that refused it. The queue is persisted and the
 * session's history no longer holds the prompt, so this record is the only
 * place the message and its error survive a reopened chat. Parked, nothing
 * re-sends it until the operator does: a provider that refused a prompt
 * usually refuses the same prompt again. Sending it again makes one user
 * turn, since the history holds none of the refused attempt.
 */
export function parkWithdrawnQueuedMessage(
  sessionId: string,
  queuedMessage: QueuedMessageRecord,
  error: unknown,
  options: { notify?: boolean } = {},
): void {
  const message = formatAcpErrorMessage(error);
  // The failed workspace-send shape is the queue's one parked state: it is
  // persisted, kept first, offered to resend and never drained on its own.
  // No workspaces are desired, so nothing sets any up before the resend.
  const state: DeferredWorkspaceSend = {
    type: "workspace-first-send",
    status: "failed",
    projectId:
      useChatSessionStore.getState().getSession(sessionId)?.projectId ?? "",
    desired: [],
    error: message,
  };
  // The refused attempt stays recorded against its task: only a host-proven
  // quota withdrawal lets the same task run again. Sending the message again
  // is a new accepted task, the identity an edit gives it.
  const payload = {
    ...queuedMessage.payload,
    executorRequestKey: `chat:${crypto.randomUUID()}`,
  };
  const store = useChatStore.getState();
  if (
    !store.deferTransportReadyMessage(
      sessionId,
      queuedMessage.recordId,
      state,
      payload,
    )
  ) {
    // The usual case: the queue let the record go once the prompt was sent.
    store.restoreUnacceptedQueuedMessage(sessionId, {
      kind: "deferred",
      recordId: queuedMessage.recordId,
      payload,
      state,
    });
  }
  if (options.notify) notifyParkedSend(sessionId, message);
}
