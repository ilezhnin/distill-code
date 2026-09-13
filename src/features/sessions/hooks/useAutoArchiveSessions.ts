import { useEffect } from "react";
import { acpSessionToChatSession } from "@/features/chat/lib/acpSessionMapping";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  isSessionRunning,
  sessionActivityAt,
} from "@/features/chat/lib/sessionActivity";
import { loadAllSessionsForWorkspaceCleanup } from "@/features/chat/lib/sessionWorkspaceCleanup";
import { acpGetSessionInfo } from "@/shared/api/acp";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import {
  AUTO_ARCHIVE_CHANGED_EVENT,
  getAutoArchiveAfterMs,
} from "@/features/settings/lib/autoArchivePreference";
import { getChatSessionIdsWithTerminals } from "@/features/terminal/lib/terminalSessionManager";
import { getAutoArchiveSessionCandidates } from "../lib/autoArchiveSessions";

const AUTO_ARCHIVE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

interface AutoArchiveResult {
  ok: boolean;
}

type RevalidateAutoArchive = () => Promise<boolean>;

interface RunAutoArchiveSweepOptions {
  archiveSession: (
    session: ChatSession,
    revalidate: RevalidateAutoArchive,
  ) => Promise<AutoArchiveResult>;
  nowMs?: number;
}

let sweepPromise: Promise<void> | null = null;
let lastSweepStartedAtMs: number | null = null;

function hasLocalAutoArchiveBlocker(sessionId: string): boolean {
  const chatState = useChatStore.getState();
  const runtime = chatState.getSessionRuntime(sessionId);
  return (
    isSessionRunning(runtime.chatState) ||
    runtime.isRunCancellationPending ||
    chatState.nonEmptyDraftSessionIds.has(sessionId) ||
    (chatState.queuedMessageBySession[sessionId]?.length ?? 0) > 0 ||
    (chatState.skillDraftsBySession[sessionId]?.length ?? 0) > 0 ||
    (chatState.draftAttachmentsBySession[sessionId]?.length ?? 0) > 0 ||
    // A live shell is work in progress the transcript cannot see: archiving
    // the chat would hide a dev server that keeps its port until the app
    // exits. Manual archiving stops the shells; the sweep leaves them be.
    getChatSessionIdsWithTerminals().has(sessionId)
  );
}

/**
 * Whether a sweep prompted by the window becoming visible is worth running.
 *
 * Every restore from the taskbar fires `visibilitychange`; a sweep is a full
 * session pagination plus a host round trip per candidate, and nothing ages
 * into the window between two restores a few minutes apart. The hourly
 * timer's cadence is the bound: a visibility sweep runs only when no sweep
 * has started within the last interval.
 */
export function shouldSweepOnVisibility(
  lastStartedAtMs: number | null,
  nowMs: number,
  intervalMs: number = AUTO_ARCHIVE_SWEEP_INTERVAL_MS,
): boolean {
  return lastStartedAtMs === null || nowMs - lastStartedAtMs >= intervalMs;
}

async function revalidateAutoArchiveCandidate(
  originalSession: ChatSession,
): Promise<ChatSession | null> {
  const afterMs = getAutoArchiveAfterMs();
  if (afterMs === null) return null;

  const sessionStore = useChatSessionStore.getState();
  if (!useChatStore.getState().hasHydratedMessageQueues) return null;
  if (sessionStore.activeSessionId === originalSession.id) return null;
  if (sessionStore.archiveMutationBySessionId[originalSession.id]) return null;
  if (hasLocalAutoArchiveBlocker(originalSession.id)) return null;

  const sessionInfo = await acpGetSessionInfo(originalSession.id);
  const refreshedSession = sessionInfo
    ? acpSessionToChatSession(sessionInfo)
    : undefined;
  const localSession = sessionStore.getSession(originalSession.id);
  const latestSession = localSession
    ? ({ ...refreshedSession, ...localSession } satisfies ChatSession)
    : refreshedSession;
  if (!latestSession || latestSession.archivedAt) return null;

  const activityMs = Math.max(
    ...[refreshedSession, localSession]
      .filter((session): session is ChatSession => session !== undefined)
      .map((session) => Date.parse(sessionActivityAt(session)))
      .filter(Number.isFinite),
  );
  if (
    !Number.isFinite(activityMs) ||
    activityMs > Date.now() - afterMs ||
    getAutoArchiveAfterMs() === null
  ) {
    return null;
  }

  const latestSessionStore = useChatSessionStore.getState();
  if (
    latestSessionStore.activeSessionId === originalSession.id ||
    hasLocalAutoArchiveBlocker(originalSession.id) ||
    getAutoArchiveAfterMs() === null
  ) {
    return null;
  }

  return latestSessionStore.getSession(originalSession.id) ?? latestSession;
}

export async function runAutoArchiveSweep({
  archiveSession,
  nowMs = Date.now(),
}: RunAutoArchiveSweepOptions): Promise<void> {
  const afterMs = getAutoArchiveAfterMs();
  if (afterMs === null) return;

  const sessions = await loadAllSessionsForWorkspaceCleanup();
  if (getAutoArchiveAfterMs() === null) return;

  if (!useChatStore.getState().hasHydratedMessageQueues) return;
  const sessionStore = useChatSessionStore.getState();
  const localSessionsById = new Map(
    sessionStore.sessions.map((session) => [session.id, session]),
  );
  const candidates = getAutoArchiveSessionCandidates({
    sessions: sessions.map((session) => {
      const localSession = localSessionsById.get(session.id);
      return localSession
        ? ({ ...session, ...localSession } satisfies ChatSession)
        : session;
    }),
    afterMs,
    nowMs,
  });

  // Use the same serialized archive transaction as manual actions. Revalidate
  // every safety invariant at each turn because earlier candidates can spend
  // time in Git inspection and cleanup while the user keeps interacting.
  for (const candidate of candidates) {
    try {
      const currentSession = await revalidateAutoArchiveCandidate(candidate);
      if (!currentSession) continue;
      await archiveSession(currentSession, async () => {
        const revalidated =
          await revalidateAutoArchiveCandidate(currentSession);
        return revalidated !== null;
      });
    } catch (error) {
      console.error(
        `Failed to automatically archive chat ${candidate.id}:`,
        error,
      );
    }
  }
}

export function useAutoArchiveSessions(
  archiveSession: (
    session: ChatSession,
    revalidate: RevalidateAutoArchive,
  ) => Promise<AutoArchiveResult>,
): void {
  useEffect(() => {
    let cancelled = false;

    const sweep = () => {
      if (cancelled || document.visibilityState === "hidden") return;
      if (sweepPromise) return;

      lastSweepStartedAtMs = Date.now();
      sweepPromise = runAutoArchiveSweep({ archiveSession })
        .catch((error) => {
          console.error(
            "Failed to automatically archive inactive chats:",
            error,
          );
        })
        .finally(() => {
          sweepPromise = null;
        });
    };
    const handleVisibilityChange = () => {
      if (
        document.visibilityState === "visible" &&
        shouldSweepOnVisibility(lastSweepStartedAtMs, Date.now())
      ) {
        sweep();
      }
    };

    sweep();
    const intervalId = window.setInterval(
      sweep,
      AUTO_ARCHIVE_SWEEP_INTERVAL_MS,
    );
    window.addEventListener(AUTO_ARCHIVE_CHANGED_EVENT, sweep);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener(AUTO_ARCHIVE_CHANGED_EVENT, sweep);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [archiveSession]);
}
