import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { Message } from "@/shared/types/messages";
import { isRecord } from "@/shared/lib/isRecord";
import { appendTerminalOutputToMessage } from "../lib/terminalOutput";

export function hasTerminalOutput(update: SessionUpdate): boolean {
  return getTerminalOutputData(update).length > 0;
}

export function getTerminalOutputData(update: SessionUpdate): string {
  const output =
    update._meta?.terminal_output_delta ?? update._meta?.terminal_output;
  return isRecord(output) && typeof output.data === "string" ? output.data : "";
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
  return appendTerminalOutputToMessage(
    message,
    update.toolCallId,
    getTerminalOutputData(update),
  );
}
