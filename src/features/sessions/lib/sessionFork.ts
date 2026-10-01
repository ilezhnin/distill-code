import type { AcpForkSessionOptions } from "@/shared/api/acpApi";
import type { Message } from "@/shared/types/messages";

/** Select an exact stored message; wall-clock seconds cannot separate turns. */
export function getMessageForkTarget(
  messages: readonly Message[],
  messageId: string,
): AcpForkSessionOptions["conversationThrough"] | null {
  const message = messages.find((message) => message.id === messageId);
  if (
    !message ||
    message.metadata?.userVisible === false ||
    (message.role !== "user" && message.role !== "assistant")
  ) {
    return null;
  }
  return { messageId: message.id, role: message.role };
}
