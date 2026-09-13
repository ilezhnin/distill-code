/**
 * Draining agent-filed tasks into the planner.
 *
 * Mounted once, app-wide: an agent can file work from any session, not only
 * from a conductor, and the operator's list is one list. The store owns
 * idempotency (a message id is filed at most once, and the tombstone
 * persists), so this hook may run as often as the chat store changes —
 * which, while a reply streams, is once per token.
 */

import { useEffect } from "react";

import { useChatStore } from "@/features/chat/stores/chatStore";
import { messageIdSet } from "@/features/memory/lib/transcriptScan";

import { detectPlannerFenceCandidates } from "./lib/plannerAgentScan";
import { usePlannerStore } from "./stores/plannerStore";

let draining = false;

function drainPlannerFences(): void {
  // The store write below wakes this same subscription. Nothing here is
  // recursive in principle — the tombstone makes a second pass find nothing —
  // but the conductor's graph sync taught us not to rely on that in
  // principle, so nested entry is dropped outright.
  // Not before the stored list is read. Until then the filed tombstones are
  // empty, so every fence in every cached transcript looks new and a task
  // completed long ago would be filed again. The drain runs again when the
  // read lands.
  if (!usePlannerStore.getState().hydrated) return;
  if (draining) return;
  draining = true;
  try {
    const planner = usePlannerStore.getState();
    // The filed tombstones as a set: this predicate is asked about every
    // message of every cached transcript on every pass.
    const applied = messageIdSet(planner.appliedMessageIds);
    const candidates = detectPlannerFenceCandidates({
      messagesBySession: useChatStore.getState().messagesBySession,
      isApplied: (messageId) => applied.has(messageId),
    });
    for (const candidate of candidates) {
      usePlannerStore
        .getState()
        .applyAgentRequest(
          candidate.messageId,
          candidate.sessionId,
          candidate.request,
        );
    }
  } finally {
    draining = false;
  }
}

export function usePlannerAgentSync(): void {
  useEffect(() => {
    drainPlannerFences();
    // On the transcripts only: the chat store's runtime flags change on every
    // streamed token's bookkeeping as well as the token itself, and no flag can
    // make a message into a filed task. The scan reads `messagesBySession`.
    const stopWatchingMessages = useChatStore.subscribe(
      (state) => state.messagesBySession,
      () => {
        drainPlannerFences();
      },
    );
    const stopWatchingHydration = usePlannerStore.subscribe(
      (state, previous) => {
        if (state.hydrated && !previous.hydrated) drainPlannerFences();
      },
    );
    return () => {
      stopWatchingMessages();
      stopWatchingHydration();
    };
  }, []);
}
