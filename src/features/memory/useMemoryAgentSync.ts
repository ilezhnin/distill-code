/**
 * Draining what agents ask to remember into the operator's memory.
 *
 * Mounted once, app-wide, for the same reason the planner's drain is: an
 * agent can learn something in any session. The scope a memory lands in comes
 * from the session's own project, never from the agent — a model cannot be
 * allowed to decide which project a fact belongs to by naming one.
 */

import { useEffect } from "react";

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";

import { BoundedSet } from "@/features/conductor/boundedSet";

import { detectMemoryFenceCandidates } from "./lib/memoryAgentScan";
import {
  memoryWriteDenialText,
  sessionMemoryWriteAccess,
} from "./lib/memoryWriteAccess";
import { useMemoryStore } from "./stores/memoryStore";

let draining = false;

/**
 * Sessions this process has already read in full.
 *
 * Bounded, and losing an entry only costs one extra deep pass — the applied
 * tombstones are what stop a fence being honoured twice, not this. See
 * `MEMORY_DEEP_SCAN_LIMIT` for why the first pass has to be deep at all.
 */
const deeplyScanned = new BoundedSet(200);

function takeFirstScan(sessionId: string): boolean {
  if (deeplyScanned.has(sessionId)) return false;
  deeplyScanned.add(sessionId);
  return true;
}

/** Test seam: lets a case run the first-scan path again. */
export function resetMemoryDeepScanForTests(): void {
  deeplyScanned.clear();
}

function drainMemoryFences(): void {
  if (draining) return;
  draining = true;
  try {
    const memory = useMemoryStore.getState();
    const candidates = detectMemoryFenceCandidates({
      messagesBySession: useChatStore.getState().messagesBySession,
      isApplied: (messageId) => memory.appliedMessageIds.includes(messageId),
      isFirstScan: takeFirstScan,
    });
    if (candidates.length === 0) return;
    const sessions = useChatSessionStore.getState();
    for (const candidate of candidates) {
      // The memory ACL: a conductor-graph session only writes when its layer
      // allows it. Refused fences are tombstoned — not applied — and said out
      // loud, in the spirit of the digest's "[protocol block removed]": a
      // request the app silently swallows looks to the operator like one it
      // honored.
      const access = sessionMemoryWriteAccess(candidate.sessionId);
      if (!access.allowed) {
        useMemoryStore.getState().dismissAgentRequest(candidate.messageId);
        console.warn(
          `[memory] distill-memory fence in session ${candidate.sessionId} was not applied: ${memoryWriteDenialText(access.denial)}`,
        );
        continue;
      }
      const projectId =
        sessions.getSession(candidate.sessionId)?.projectId ?? null;
      useMemoryStore
        .getState()
        .applyAgentRequest(
          candidate.messageId,
          candidate.sessionId,
          projectId,
          candidate.request,
        );
    }
  } finally {
    draining = false;
  }
}

export function useMemoryAgentSync(): void {
  useEffect(() => {
    drainMemoryFences();
    return useChatStore.subscribe(() => {
      drainMemoryFences();
    });
  }, []);
}
