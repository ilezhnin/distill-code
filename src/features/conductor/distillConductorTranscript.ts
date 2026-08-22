import type { Message, MessageContent } from "@/shared/types/messages";

const VISIBLE_BLOCK_TYPES = new Set<MessageContent["type"]>([
  "text",
  "image",
  "mcpApp",
]);

function isVisibleConductorBlock(block: MessageContent): boolean {
  if (block.type === "systemNotification") {
    return (
      block.notificationType === "error" || block.notificationType === "warning"
    );
  }
  return VISIBLE_BLOCK_TYPES.has(block.type);
}

function hasVisibleConductorContent(
  content: readonly MessageContent[],
): boolean {
  return content.some((block) => {
    if (block.type === "text") {
      return block.text.trim().length > 0;
    }
    return true;
  });
}

export function distillConductorTranscript(
  messages: readonly Message[],
): Message[] {
  return messages.flatMap((message) => {
    if (message.role === "user" || message.role === "system") {
      return [message];
    }

    const content = message.content.filter(isVisibleConductorBlock);
    if (!hasVisibleConductorContent(content)) {
      return [];
    }
    return [{ ...message, content }];
  });
}
