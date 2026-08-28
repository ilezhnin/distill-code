/**
 * Finding the agent messages that ask to remember something.
 *
 * Pure, and shaped like the planner's scan: transcripts plus a "have I read
 * this one" predicate in, candidates out.
 */

import { getTextContent, type Message } from "@/shared/types/messages";

import {
  MEMORY_FENCE_TAG,
  parseMemoryFences,
  type MemoryFenceRequest,
} from "./memoryFence";

export interface MemoryFenceCandidate {
  sessionId: string;
  messageId: string;
  request: MemoryFenceRequest;
}

/** How far back a scan reads. The subscription fires on every streamed token. */
export const MEMORY_SCAN_TAIL = 40;

/**
 * How far a session's first scan reads.
 *
 * The tail is right for the hot path — this runs on every streamed token —
 * and wrong exactly once per session. A fence written before the app was last
 * closed, or refused by the ACL and later granted, sits wherever it sat; when
 * the transcript is replayed it can be a hundred messages back, and a tail of
 * forty means the operator's agent asked to remember something and the app
 * quietly never did. So each session gets one deep pass the first time its
 * messages are seen in this process, and the tail from then on: the cost is
 * bounded by the number of sessions opened, and the hole it closes is a
 * memory silently lost.
 */
export const MEMORY_DEEP_SCAN_LIMIT = 1000;

function isSettledAssistantMessage(message: Message): boolean {
  return (
    message.role === "assistant" &&
    message.metadata?.completionStatus !== "inProgress"
  );
}

export function detectMemoryFenceCandidates(args: {
  messagesBySession: Readonly<Record<string, readonly Message[] | undefined>>;
  isApplied: (messageId: string) => boolean;
  /**
   * True the first time this process sees a session's messages. Callers that
   * omit it get the tail for every session, which is the old behaviour.
   */
  isFirstScan?: (sessionId: string) => boolean;
}): MemoryFenceCandidate[] {
  const candidates: MemoryFenceCandidate[] = [];
  for (const [sessionId, messages] of Object.entries(args.messagesBySession)) {
    if (!messages?.length) continue;
    const depth = args.isFirstScan?.(sessionId)
      ? MEMORY_DEEP_SCAN_LIMIT
      : MEMORY_SCAN_TAIL;
    for (const message of messages.slice(-depth)) {
      if (!isSettledAssistantMessage(message)) continue;
      if (args.isApplied(message.id)) continue;
      const text = getTextContent(message);
      if (!text.includes(MEMORY_FENCE_TAG)) continue;
      const request = parseMemoryFences(text);
      if (!request) continue;
      candidates.push({ sessionId, messageId: message.id, request });
    }
  }
  return candidates;
}
