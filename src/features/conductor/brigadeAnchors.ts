import type { Message } from "@/shared/types/messages";

import { latestConductorFooterHostId } from "./ConductorTranscriptContext";
import type { SessionNode } from "./types";

/**
 * Brigade children grouped by the transcript message that hosts their chip
 * row. Built once per transcript render so every bubble is an O(1) lookup.
 */
export type BrigadeNodesByMessageId = ReadonlyMap<
  string,
  readonly SessionNode[]
>;

/** Shared empty result so bubbles that host nothing keep a stable identity. */
export const NO_BRIGADE_NODES: readonly SessionNode[] = Object.freeze([]);

export const EMPTY_BRIGADE_NODES_BY_MESSAGE_ID: BrigadeNodesByMessageId =
  new Map<string, readonly SessionNode[]>();

/**
 * Assign every brigade child to the message whose chip row owns it.
 *
 * A child anchored to a message that exists in this transcript
 * (`anchorMessageId`) stays on that message forever — historical waves keep
 * their own row. Children without an anchor (or anchored to a message this
 * transcript does not contain) fall back to the single latest host message,
 * which is the pre-per-message behavior.
 */
export function groupBrigadeNodesByHostMessage(
  nodes: readonly SessionNode[],
  messages: readonly Message[],
): BrigadeNodesByMessageId {
  if (nodes.length === 0) return EMPTY_BRIGADE_NODES_BY_MESSAGE_ID;

  const knownMessageIds = new Set<string>();
  for (const message of messages) knownMessageIds.add(message.id);

  let fallbackHostId: string | null | undefined;
  const grouped = new Map<string, SessionNode[]>();

  for (const node of nodes) {
    let hostId: string | null;
    if (node.anchorMessageId && knownMessageIds.has(node.anchorMessageId)) {
      hostId = node.anchorMessageId;
    } else {
      if (fallbackHostId === undefined) {
        fallbackHostId = latestConductorFooterHostId(messages);
      }
      hostId = fallbackHostId;
    }
    if (!hostId) continue;
    const bucket = grouped.get(hostId);
    if (bucket) {
      bucket.push(node);
    } else {
      grouped.set(hostId, [node]);
    }
  }

  return grouped;
}

/** Chips a single message owns; a shared empty array when it owns none. */
export function brigadeNodesForMessage(
  grouped: BrigadeNodesByMessageId,
  messageId: string,
): readonly SessionNode[] {
  return grouped.get(messageId) ?? NO_BRIGADE_NODES;
}
