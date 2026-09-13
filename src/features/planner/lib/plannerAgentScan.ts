/**
 * Finding the agent messages that file work onto the planner.
 *
 * Pure, and shaped like `waveDetection`: it reads transcripts plus a "have I
 * filed this one" predicate and returns what to apply. Doing it is the store;
 * driving it is `usePlannerAgentSync`.
 */

import { isLegacyReplayReplyId } from "@/shared/api/acpReplayMetadata";
import { getTextContent, type Message } from "@/shared/types/messages";

import { messageMentions } from "@/features/memory/lib/transcriptScan";

import {
  parsePlannerFences,
  TODO_FENCE_TAG,
  type PlannerFenceRequest,
} from "./plannerFence";

export interface PlannerFenceCandidate {
  sessionId: string;
  /** The assistant message that carried the fence. Its dedup key. */
  messageId: string;
  request: PlannerFenceRequest;
}

/**
 * How far back into a transcript the scan looks.
 *
 * The subscription fires on every streamed token, so re-joining the text of
 * a thousand-message transcript on each one is not affordable. Only the tail
 * can contain a turn that just settled; anything older was scanned when it
 * did.
 */
export const PLANNER_SCAN_TAIL = 40;

function isSettledAssistantMessage(message: Message): boolean {
  return (
    message.role === "assistant" &&
    message.metadata?.completionStatus !== "inProgress" &&
    // A reply replayed under a derived id was handled when it streamed, under
    // an id no reload reproduces; its tombstone cannot match it.
    !isLegacyReplayReplyId(message.id)
  );
}

export function detectPlannerFenceCandidates(args: {
  messagesBySession: Readonly<Record<string, readonly Message[] | undefined>>;
  /** Expected to be cheap — a set lookup, not a search through a list. */
  isApplied: (messageId: string) => boolean;
}): PlannerFenceCandidate[] {
  const candidates: PlannerFenceCandidate[] = [];
  for (const [sessionId, messages] of Object.entries(args.messagesBySession)) {
    if (!messages?.length) continue;
    for (const message of messages.slice(-PLANNER_SCAN_TAIL)) {
      if (!isSettledAssistantMessage(message)) continue;
      if (args.isApplied(message.id)) continue;
      // Cheap reject before the real parse: most turns are prose, and the
      // tag test runs on the parts as they are rather than on a joined copy.
      if (!messageMentions(message, TODO_FENCE_TAG)) continue;
      const request = parsePlannerFences(getTextContent(message));
      if (!request) continue;
      candidates.push({ sessionId, messageId: message.id, request });
    }
  }
  return candidates;
}
