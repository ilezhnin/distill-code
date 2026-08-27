/**
 * Chat's reaction to `acpSessionRegistry` refusing to pin a model the live
 * harness never listed.
 *
 * The registry cannot do this part itself — it is shared code and must not
 * import the chat feature — and chat cannot do the detection, because only the
 * registry sees the session snapshot the harness sent. So the split is the
 * same one the config-snapshot handlers use: the registry decides, this
 * adapter is what the operator sees.
 *
 * What they see is a card in the chat, not a toast. The refusal changes which
 * model the conversation runs on; that belongs in the transcript, where it is
 * still readable when they come back to the window.
 */

import {
  setUndeclaredSessionModelHandler,
  type UndeclaredSessionModel,
} from "@/shared/api/acpSessionRegistry";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { createSystemNotificationMessage } from "@/shared/types/messages";
import { noticeForUndeclaredSessionModel } from "@/features/chat/lib/rejectedModelRecovery";

export function handleUndeclaredSessionModel(
  event: UndeclaredSessionModel,
): void {
  console.warn(
    `ACP harness ${event.providerId} does not list model ${event.modelId}; ` +
      `session left on ${event.fallbackModelId || "the harness' current model"}`,
    { declaredModelIds: event.declaredModelIds.slice(0, 20) },
  );
  const notice = noticeForUndeclaredSessionModel({
    sessionId: event.sessionId,
    providerId: event.providerId,
    modelId: event.modelId,
  });
  useChatStore
    .getState()
    .addMessage(
      event.sessionId,
      createSystemNotificationMessage(notice, "warning"),
    );
}

export function registerUndeclaredSessionModelHandler(): void {
  setUndeclaredSessionModelHandler(handleUndeclaredSessionModel);
}
