import type { Message } from "@/shared/types/messages";

export function appendTerminalOutputToMessage(
  message: Message,
  toolCallId: string,
  data: string,
): Message {
  if (!data) return message;
  let changed = false;
  const content = message.content.map((block) => {
    if (block.type !== "toolRequest" || block.id !== toolCallId) return block;
    changed = true;
    return { ...block, terminalOutput: (block.terminalOutput ?? "") + data };
  });
  return changed ? { ...message, content } : message;
}
