import { sessionActivityAt } from "@/features/chat/lib/sessionActivity";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";

export interface AutoArchiveSessionCandidateOptions {
  sessions: ChatSession[];
  afterMs: number | null;
  nowMs?: number;
}

/**
 * Select inactive sessions that are safe to consider for automatic archiving.
 * The caller remains responsible for checking live runtime state and applying
 * the normal archive transaction.
 *
 * Chat-pin protection is gone along with the home widget desktop that owned
 * the pins: there is no surface left that can pin a chat, and a protection
 * read from a dead layout would silently exempt sessions forever.
 */
export function getAutoArchiveSessionCandidates({
  sessions,
  afterMs,
  nowMs = Date.now(),
}: AutoArchiveSessionCandidateOptions): ChatSession[] {
  if (afterMs === null) return [];

  const cutoffMs = nowMs - afterMs;

  return sessions.filter((session) => {
    if (
      session.archivedAt ||
      session.creationState ||
      session.pinnedLoadState
    ) {
      return false;
    }

    const activityMs = Date.parse(sessionActivityAt(session));
    return Number.isFinite(activityMs) && activityMs <= cutoffMs;
  });
}
