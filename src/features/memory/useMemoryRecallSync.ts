/**
 * Answering what agents ask the operator's memory.
 *
 * The read half of the same drain `useMemoryAgentSync` runs for writes, and
 * mounted the same way — app-wide, once — because a session can ask from
 * anywhere. Three things differ, and each is a rule rather than a detail:
 *
 * - Writing is gated by the memory ACL; reading is not. A read-only worker
 *   still gets the block, so it still has to be able to ask for what the
 *   block left out (LAWS/MEMORY.md, Reading back). The operator's own read
 *   switch is the exception, and it belongs here rather than with writing:
 *   an answer is memory reaching a session's context, which is exactly what
 *   that switch turns off. The law's premise goes with it — a session that
 *   receives no memories, and was never taught the fence, has nothing this
 *   answer would complete.
 * - A wave child gets no answer. It never received the block or the protocol
 *   in the first place, and everything it learns goes up through its report
 *   to the conductor's loop.
 * - Reach is the session's own: global memories plus this session's project,
 *   live and archived. Another project's memories never travel, which is the
 *   law this whole path most easily breaks.
 *
 * The answer is one ordinary message, delivered through `deliverEnvelope` —
 * the same seam a wave digest uses, so a busy session queues instead of
 * dropping it, and the model actually runs again on receipt.
 */

import { useEffect } from "react";

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  isConductorGraphHydrated,
  whenConductorGraphHydrated,
} from "@/features/conductor/conductorGraphStore";
import { deliverEnvelope } from "@/features/conductor/digestDelivery";
import { isWaveManagedSession } from "@/features/conductor/waveManagedSession";
import { useProjectStore } from "@/features/projects/stores/projectStore";

import { getMemoryPreferences } from "./lib/memoryPreferences";
import {
  detectRecallFenceCandidates,
  formatRecallAnswer,
  recallBudgetSpent,
  recallReachable,
  RECALL_LIMIT_REACHED_TEXT,
  type MemoryRecallCandidate,
} from "./lib/memoryRecall";
import { searchMemories } from "./lib/memorySearch";
import { messageIdSet } from "./lib/transcriptScan";
import { useMemoryStore } from "./stores/memoryStore";

let draining = false;

function projectNameOf(projectId: string | null): string {
  const project = useProjectStore
    .getState()
    .projects.find((candidate) => candidate.id === projectId);
  // Only ever asked about this session's own project, so the fallback is a
  // name for it rather than an id the model has no use for.
  return project?.name ?? "this project";
}

function answerFor(candidate: MemoryRecallCandidate): string {
  if (recallBudgetSpent(candidate.recentTexts))
    return RECALL_LIMIT_REACHED_TEXT;
  const memory = useMemoryStore.getState();
  const projectId =
    useChatSessionStore.getState().getSession(candidate.sessionId)?.projectId ??
    null;
  const { query, scope, limit } = candidate.request;
  const hits = searchMemories(
    recallReachable(memory.entries, projectId, scope),
    query,
    {
      limit,
      archived: recallReachable(memory.archived, projectId, scope),
    },
  );
  return formatRecallAnswer(hits, projectNameOf, query);
}

function drainRecallFences(): void {
  // Not before the stored memory is read: the answered tombstones are empty
  // until then, so every question already answered in an earlier run would
  // be answered again, and the answer would search an empty list.
  if (!useMemoryStore.getState().hydrated) return;
  // Nor before the graph is read: a wave child whose node is still on disk
  // would look like the operator's chat and be sent the operator's memories.
  if (!isConductorGraphHydrated()) return;
  if (draining) return;
  draining = true;
  try {
    // As a set: the predicate is asked about every message of every cached
    // transcript on every pass, and the list of answered questions is bounded
    // by a thousand, not by one.
    const answered = messageIdSet(
      useMemoryStore.getState().recallAnsweredMessageIds,
    );
    const candidates = detectRecallFenceCandidates({
      messagesBySession: useChatStore.getState().messagesBySession,
      isAnswered: (messageId) => answered.has(messageId),
    });
    for (const candidate of candidates) {
      // Tombstoned before anything else happens: delivery is asynchronous and
      // itself changes the transcript this drain listens to, so a question
      // still marked unanswered when the next pass runs is a question asked
      // twice.
      useMemoryStore.getState().markRecallAnswered(candidate.messageId);
      // Refused rather than deferred, which is where this parts company with
      // the write pause: a write held back is applied later and the fact
      // survives, while an answer held back would arrive in a conversation
      // that has long since moved on. Said out loud for the same reason
      // every other unanswered fence is.
      if (!getMemoryPreferences().read) {
        console.warn(
          `[memory] distill-recall fence in session ${candidate.sessionId} was not answered: mixing memory into prompts is switched off`,
        );
        continue;
      }
      if (isWaveManagedSession(candidate.sessionId)) {
        // Said out loud, like a refused write fence: a request the app
        // silently swallows looks to the operator like one it honoured.
        console.warn(
          `[memory] distill-recall fence in session ${candidate.sessionId} was not answered: the wave engine manages this session`,
        );
        continue;
      }
      void deliverEnvelope(candidate.sessionId, answerFor(candidate)).then(
        (result) => {
          if (result.status === "failed") {
            console.warn(
              `[memory] recall answer for session ${candidate.sessionId} was not delivered: ${result.detail ?? "unknown reason"}`,
            );
          }
        },
      );
    }
  } finally {
    draining = false;
  }
}

export function useMemoryRecallSync(): void {
  useEffect(() => {
    drainRecallFences();
    // On the transcripts only, for the reason the write drain says: a runtime
    // flag cannot make a question out of a message, and the flags change more
    // often than the transcripts do.
    const stopWatchingMessages = useChatStore.subscribe(
      (state) => state.messagesBySession,
      () => {
        drainRecallFences();
      },
    );
    const stopWatchingHydration = useMemoryStore.subscribe(
      (state, previous) => {
        if (state.hydrated && !previous.hydrated) drainRecallFences();
      },
    );
    whenConductorGraphHydrated(drainRecallFences);
    return () => {
      stopWatchingMessages();
      stopWatchingHydration();
    };
  }, []);
}
