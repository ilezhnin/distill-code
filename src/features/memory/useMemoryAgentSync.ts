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
  getMemoryPreferences,
  subscribeToMemoryPreferenceChanges,
} from "./lib/memoryPreferences";
import {
  memoryWriteDenialText,
  sessionMemoryWriteAccess,
} from "./lib/memoryWriteAccess";
import {
  memoryRememberRefusal,
  useMemoryStore,
  type MemoryRefusal,
} from "./stores/memoryStore";

/**
 * What the operator is told about a refused statement.
 *
 * By kind only: the statement is what must not be written down, and a console
 * line is written down too. Each reason says what would make the same request
 * work next time, because "refused" on its own is a dead end.
 */
function refusalText(refusal: MemoryRefusal): string {
  switch (refusal.reason) {
    case "secret":
      return `looks like a secret (${refusal.shape})`;
    case "no-project":
      return "a project fact needs a project, and this chat has none";
    case "blank":
      return "nothing was left of it once it was trimmed";
  }
}

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

/**
 * Arms the deep pass again for every session.
 *
 * Called when writing is switched back on, and that is the whole reason it
 * is not test-only any more: while the switch was off nothing was scanned
 * and nothing was tombstoned, so the fences agents wrote during the pause
 * are still sitting in their transcripts — but by now they are usually
 * further back than `MEMORY_SCAN_TAIL` reaches. Re-arming the deep pass is
 * what makes the pause a delay rather than a loss.
 */
export function resetMemoryDeepScan(): void {
  deeplyScanned.clear();
}

function drainMemoryFences(): void {
  // Writing is paused. The return has to come before the scan, not before
  // `applyAgentRequest`: a candidate this drain looks at is tombstoned
  // whether or not it is applied, and a tombstoned fence never comes back.
  // Reading nothing means marking nothing, so the requests stay in their
  // transcripts and land when the operator switches writing back on.
  if (!getMemoryPreferences().write) return;
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
      // A statement the store will not keep is said out loud here, the same
      // courtesy a refused fence already gets and for the same reason —
      // silence looks to the operator like the app agreed. One line per
      // refused item, from the store's own verdict, so what is reported is
      // exactly what was acted on. The `forget` paired with it was not
      // applied either, so nothing was lost while this was refused.
      for (const item of candidate.request.remember) {
        const refusal = memoryRememberRefusal(item, projectId);
        if (!refusal) continue;
        console.warn(`[memory] statement refused: ${refusalText(refusal)}`);
      }
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
    const stopWatchingMessages = useChatStore.subscribe(() => {
      drainMemoryFences();
    });
    // The catch-up. Subscribed rather than wired into the switch itself so
    // it runs wherever the switch is flipped from, and re-armed on any
    // preference change while writing is on — an extra deep pass costs one
    // scan, a missed one costs the operator a memory.
    const stopWatchingPreferences = subscribeToMemoryPreferenceChanges(() => {
      if (!getMemoryPreferences().write) return;
      resetMemoryDeepScan();
      drainMemoryFences();
    });
    return () => {
      stopWatchingMessages();
      stopWatchingPreferences();
    };
  }, []);
}
