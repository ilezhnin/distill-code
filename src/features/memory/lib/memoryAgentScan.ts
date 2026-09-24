/**
 * Finding the agent messages that ask to remember something.
 *
 * Pure: transcripts plus a "have I read
 * this one" predicate in, candidates out.
 */

import { isLegacyReplayReplyId } from "@/shared/api/acpReplayMetadata";
import { getTextContent, type Message } from "@/shared/types/messages";

import {
  MEMORY_FENCE_TAG,
  parseMemoryFences,
  type MemoryFenceRequest,
} from "./memoryFence";
import { messageMentions } from "./transcriptScan";

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
    message.metadata?.completionStatus !== "inProgress" &&
    // A reply replayed under a derived id was handled when it streamed, under
    // an id no reload reproduces; its tombstone cannot match it.
    !isLegacyReplayReplyId(message.id)
  );
}

export function detectMemoryFenceCandidates(args: {
  messagesBySession: Readonly<Record<string, readonly Message[] | undefined>>;
  /** Expected to be cheap — a set lookup, not a search through a list. */
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
      // The tag test rejects nearly every message, so it runs on the parts
      // as they are; the text is only joined for the ones it lets through.
      if (!messageMentions(message, MEMORY_FENCE_TAG)) continue;
      const request = parseMemoryFences(getTextContent(message));
      if (!request) continue;
      candidates.push({ sessionId, messageId: message.id, request });
    }
  }
  return candidates;
}
