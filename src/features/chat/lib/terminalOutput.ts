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

/**
 * The output a running tool has reported so far, as a whole: ACP carries it
 * in `content` of a `tool_call_update` that is not the completion, and each
 * report replaces the one before (the Z.ai/OpenCode bridge sends the whole
 * output every ~90 s). Kept as the request's streamed output, so a long
 * command shows what it is doing and not only for how long.
 */
export function setStreamedToolOutputOnMessage(
  message: Message,
  toolCallId: string,
  output: string,
): Message {
  if (!output) return message;
  let changed = false;
  const content = message.content.map((block) => {
    if (block.type !== "toolRequest" || block.id !== toolCallId) return block;
    if (block.terminalOutput === output) return block;
    changed = true;
    return { ...block, terminalOutput: output };
  });
  return changed ? { ...message, content } : message;
}
