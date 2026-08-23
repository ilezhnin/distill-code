import { getTextContent, type Message } from "@/shared/types/messages";

import type { RunStatus, StructuredReport } from "./types";

export function lastCompletedAssistantSummary(
  messages: readonly Message[] | undefined,
): string | null {
  if (!messages?.length) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    if (message.metadata?.completionStatus === "inProgress") continue;
    const text = getTextContent(message).trim();
    if (text.length > 0) return text;
  }
  return null;
}

export function reportStatusFromRun(
  status: RunStatus,
): StructuredReport["status"] | null {
  if (status === "completed" || status === "failed" || status === "cancelled") {
    return status;
  }
  return null;
}
