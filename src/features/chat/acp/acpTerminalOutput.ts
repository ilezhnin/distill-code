import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { Message } from "@/shared/types/messages";
import { isRecord } from "@/shared/lib/isRecord";

export function hasTerminalOutput(update: SessionUpdate): boolean {
  const output =
    update._meta?.terminal_output_delta ?? update._meta?.terminal_output;
  return (
    isRecord(output) &&
    typeof output.data === "string" &&
    output.data.length > 0
  );
}

/** Both terminal extensions carry deltas (the older name lacked the suffix). */
export function appendTerminalOutput(
  message: Message,
  update: SessionUpdate,
): Message {
  if (
    update.sessionUpdate !== "tool_call" &&
    update.sessionUpdate !== "tool_call_update"
  )
    return message;
  const meta = update._meta;
  const output = meta?.terminal_output_delta ?? meta?.terminal_output;
  if (
    !isRecord(output) ||
    typeof output.data !== "string" ||
    output.data.length === 0
  )
    return message;
  const data = output.data;
  return {
    ...message,
    content: message.content.map((block) =>
      block.type === "toolRequest" && block.id === update.toolCallId
        ? { ...block, terminalOutput: (block.terminalOutput ?? "") + data }
        : block,
    ),
  };
}
