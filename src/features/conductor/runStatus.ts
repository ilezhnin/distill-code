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

/**
 * Why the agent's last reply failed, in the host's words, or null.
 *
 * The runtime holds the same reason while the renderer that saw the failure
 * is alive; after a reload only the reply carries it (`failureReason`, which
 * the host records with the turn's end). A conductor's digest reads it from
 * here so a worker the bridge died under is reported as that, not as "the
 * agent failed".
 */
export function lastFailureReason(
  messages: readonly Message[] | undefined,
): string | null {
  if (!messages?.length) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    return message.metadata?.failureReason?.trim() || null;
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
