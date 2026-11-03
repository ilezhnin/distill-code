import { admitSystemInheritedQueuedMessage } from "@/features/chat/lib/admittedSend";
import { useChatStore } from "@/features/chat/stores/chatStore";

/** What the agent is told when its turn goes on under another account. */
export const SPARE_ACCOUNT_CONTINUATION_TEXT =
  "Your previous turn was cut off because its account ran out of its usage limit. " +
  "This chat now runs on another account. Continue the work from where you stopped.";

/**
 * The spare account the host found for a turn its account's limit cut off in
 * the middle (`data.continueOnAccount`), or null for any other failure.
 */
export function spareAccountToContinueOn(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("data" in error)) return null;
  const data = error.data;
  if (!data || typeof data !== "object" || !("continueOnAccount" in data))
    return null;
  const account = data.continueOnAccount;
  return typeof account === "string" && account.length > 0 ? account : null;
}

/**
 * Puts a message that continues the cut-off work into the chat's queue, where
 * the operator sees it and can edit or remove it. Dispatching it moves the
 * chat to the spare account. A chat that already holds queued messages is left
 * alone: its next message goes to the spare account anyway, and a continuation
 * behind it would arrive out of place.
 */
export function queueSpareAccountContinuation(
  sessionId: string,
  error: unknown,
): boolean {
  if (!spareAccountToContinueOn(error)) return false;
  const chat = useChatStore.getState();
  if ((chat.queuedMessageBySession[sessionId]?.length ?? 0) > 0) return false;
  return chat.enqueueTransportReadyMessage(
    sessionId,
    admitSystemInheritedQueuedMessage({
      text: SPARE_ACCOUNT_CONTINUATION_TEXT,
    }),
  );
}
