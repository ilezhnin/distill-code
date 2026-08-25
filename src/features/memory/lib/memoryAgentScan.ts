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

function isSettledAssistantMessage(message: Message): boolean {
  return (
    message.role === "assistant" &&
    message.metadata?.completionStatus !== "inProgress"
  );
}

export function detectMemoryFenceCandidates(args: {
  messagesBySession: Readonly<Record<string, readonly Message[] | undefined>>;
  isApplied: (messageId: string) => boolean;
}): MemoryFenceCandidate[] {
  const candidates: MemoryFenceCandidate[] = [];
  for (const [sessionId, messages] of Object.entries(args.messagesBySession)) {
    if (!messages?.length) continue;
    for (const message of messages.slice(-MEMORY_SCAN_TAIL)) {
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
