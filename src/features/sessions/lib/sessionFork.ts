import type { Message } from "@/shared/types/messages";

function isForkableConversationMessage(message: Message): boolean {
  return (
    message.metadata?.userVisible !== false &&
    (message.role === "user" || message.role === "assistant")
  );
}

/**
 * Returns the ACP fork cutoff second that preserves the selected message.
 *
 * Goose truncates forked sessions by deleting messages with
 * `created_timestamp >= conversationBefore`, while renderer message timestamps
 * are milliseconds. Use the next later whole-second boundary when possible so
 * the selected message and same-second siblings are retained.
 *
 * A message's `created` is when it started, and a reply keeps streaming (and
 * recording events) long after that, so the latest message has no later
 * boundary of its own: its cutoff is the second after `now`, which keeps the
 * whole reply.
 */
export function getConversationBeforeForMessageFork(
  messages: readonly Message[],
  messageId: string,
  now: number = Date.now(),
): number | null {
  const selectedIndex = messages.findIndex(
    (message) =>
      message.id === messageId && isForkableConversationMessage(message),
  );
  if (selectedIndex === -1) {
    return null;
  }

  const selectedMessage = messages[selectedIndex];
  const selectedSeconds = Math.floor(selectedMessage.created / 1000);
  for (let index = selectedIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isForkableConversationMessage(message)) {
      continue;
    }

    const messageSeconds = Math.floor(message.created / 1000);
    if (messageSeconds > selectedSeconds) {
      return messageSeconds;
    }
  }

  return Math.max(selectedSeconds, Math.floor(now / 1000)) + 1;
}
