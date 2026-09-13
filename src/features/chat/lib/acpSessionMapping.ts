import type { AcpSessionInfo, AcpSessionsPage } from "@/shared/api/acp";
import type {
  ArchiveMutationBySessionId,
  ArchiveSessionMutation,
  ChatSession,
} from "@/features/chat/stores/chatSessionStore";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import { compareSessionsByActivityDesc } from "@/features/chat/lib/sessionActivity";
import { sameSessionExecutionTarget } from "@/features/chat/lib/sessionExecutionTarget";
import { normalizeAcpTitle } from "@/features/chat/lib/sessionTitle";
import { withWorkspaceBackfill } from "@/features/chat/lib/workspaceAttachments";
import { loadPersistedChatWorkspaceMetadata } from "@/features/chat/stores/workspaceAttachmentPersistence";
import { executionTargetFromHostSession } from "@/features/chat/lib/hostExecutionTarget";

interface SessionPageState {
  sessions: ChatSession[];
  archiveMutationBySessionId: ArchiveMutationBySessionId;
  sessionPageCursor: string | null;
  hasMoreSessions: boolean;
}

export function acpSessionToChatSession(session: AcpSessionInfo): ChatSession {
  const now = new Date().toISOString();
  const persistedWorkspaceMetadata = loadPersistedChatWorkspaceMetadata(
    session.sessionId,
  );
  const executionTarget = executionTargetFromHostSession({
    providerId: session.providerId ?? undefined,
    modelId: session.modelId ?? undefined,
  });
  return withWorkspaceBackfill({
    id: session.sessionId,
    title: normalizeAcpTitle(session.title) ?? "Untitled",
    projectId: session.projectId ?? undefined,
    executionTarget,
    executionTargetSource: executionTarget ? "acp" : undefined,
    personaId: session.personaId ?? undefined,
    workingDir: session.workingDir ?? undefined,
    workspaceAttachments: persistedWorkspaceMetadata?.workspaceAttachments,
    activeWorkspaceId: persistedWorkspaceMetadata?.activeWorkspaceId,
    createdAt: session.createdAt ?? session.updatedAt ?? now,
    updatedAt: session.updatedAt ?? now,
    lastMessageAt: session.lastMessageAt ?? undefined,
    archivedAt: session.archivedAt ?? undefined,
    messageCount: session.messageCount,
    subtitle: session.subtitle ?? undefined,
    userSetName: session.userSetName,
    // `null` ("no run") is as meaningful as a run id here, so it is kept as
    // sent; only an absent field leaves the previous answer standing.
    ...(session.activeRunId !== undefined
      ? { activeRunId: session.activeRunId }
      : {}),
  });
}

/**
 * Whether two session rows say the same thing.
 *
 * `loadSessions` maps every listed session into a fresh object every 60 s (and
 * on every window focus). Handing those out replaces `sessions` and every
 * session object in it, so every list subscriber re-renders and every `useMemo`
 * keyed on a session recomputes — for data that is almost always identical.
 * Two fields are rebuilt by the mapping itself and so are compared by value:
 * `executionTarget` (built per row from the host's provider/model) and
 * `workspaceAttachments` (normalized into new objects on every backfill).
 */
function sameChatSession(left: ChatSession, right: ChatSession): boolean {
  const keys = new Set([
    ...(Object.keys(left) as (keyof ChatSession)[]),
    ...(Object.keys(right) as (keyof ChatSession)[]),
  ]);
  for (const key of keys) {
    if (key === "executionTarget") {
      if (
        !sameSessionExecutionTarget(left.executionTarget, right.executionTarget)
      ) {
        return false;
      }
      continue;
    }
    if (key === "workspaceAttachments") {
      if (
        !sameWorkspaceAttachmentLists(
          left.workspaceAttachments,
          right.workspaceAttachments,
        )
      ) {
        return false;
      }
      continue;
    }
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function sameWorkspaceAttachmentLists(
  left: ChatSession["workspaceAttachments"],
  right: ChatSession["workspaceAttachments"],
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((attachment, index) => {
    const other = right[index];
    if (attachment === other) return true;
    if (!other) return false;
    const keys = new Set([
      ...(Object.keys(attachment) as (keyof WorkspaceAttachment)[]),
      ...(Object.keys(other) as (keyof WorkspaceAttachment)[]),
    ]);
    for (const key of keys) {
      if (attachment[key] !== other[key]) return false;
    }
    return true;
  });
}

function mergeSessionMetadata(
  existingSessions: ChatSession[],
  loadedSessions: ChatSession[],
  archiveMutationBySessionId: ArchiveMutationBySessionId,
): Pick<SessionPageState, "sessions" | "archiveMutationBySessionId"> {
  const byId = new Map<string, ChatSession>();
  const mutationConfirmationBySessionId = new Map<string, boolean>();

  for (const session of existingSessions) {
    byId.set(session.id, session);
  }

  for (const loadedSession of loadedSessions) {
    const mutation = archiveMutationBySessionId[loadedSession.id];
    const confirmed = mutation
      ? isArchiveMutationConfirmed(loadedSession, mutation)
      : false;
    const session = mutation
      ? reconcileArchiveMutation(loadedSession, mutation, confirmed)
      : loadedSession;
    if (mutation) {
      mutationConfirmationBySessionId.set(session.id, confirmed);
    }

    const existing = byId.get(loadedSession.id);
    // ACP list/get metadata is discovery state. Once the renderer owns a
    // provider/model selection, preserve the complete tuple so an older list
    // response cannot replace a newer picker choice. A selection-less pinned
    // placeholder still hydrates from ACP on first resolution.
    const preserveUiTarget = existing?.executionTargetSource === "ui";
    const executionTarget = preserveUiTarget
      ? existing.executionTarget
      : session.executionTarget;
    const executionTargetSource = preserveUiTarget
      ? existing.executionTargetSource
      : session.executionTargetSource;
    const personaId = session.personaId ?? existing?.personaId;
    const merged = withWorkspaceBackfill({
      ...existing,
      ...session,
      executionTarget,
      executionTargetSource,
      personaId,
      workspaceAttachments:
        existing?.workspaceAttachments ?? session.workspaceAttachments,
      activeWorkspaceId:
        existing?.activeWorkspaceId ?? session.activeWorkspaceId,
      creationState: undefined,
      creationError: undefined,
    });
    // Keeping the existing object when nothing changed is what keeps a refresh
    // that found no news from re-rendering every list subscriber.
    byId.set(
      session.id,
      existing && sameChatSession(existing, merged) ? existing : merged,
    );
  }

  let nextArchiveMutationBySessionId = archiveMutationBySessionId;
  for (const [sessionId, confirmed] of mutationConfirmationBySessionId) {
    if (!confirmed) continue;
    // Succeeded mutations stay until this exact row confirms, so paged-out
    // sessions remain protected from later stale loadMore rows.
    if (nextArchiveMutationBySessionId === archiveMutationBySessionId) {
      nextArchiveMutationBySessionId = { ...archiveMutationBySessionId };
    }
    delete nextArchiveMutationBySessionId[sessionId];
  }

  const sessions = [...byId.values()].sort(compareSessionsByActivityDesc);
  const unchanged =
    sessions.length === existingSessions.length &&
    sessions.every((session, index) => session === existingSessions[index]);

  return {
    // Same rows in the same order: hand back the array the store already has,
    // so `selectSessions` subscribers do not re-render for a refresh that found
    // nothing new.
    sessions: unchanged ? existingSessions : sessions,
    archiveMutationBySessionId: nextArchiveMutationBySessionId,
  };
}

export function mergeAcpSessionInfo(
  state: Pick<SessionPageState, "sessions" | "archiveMutationBySessionId">,
  session: AcpSessionInfo,
): Pick<SessionPageState, "sessions" | "archiveMutationBySessionId"> {
  return mergeSessionMetadata(
    state.sessions,
    [acpSessionToChatSession(session)],
    state.archiveMutationBySessionId,
  );
}

function isArchiveMutationConfirmed(
  session: ChatSession,
  mutation: ArchiveSessionMutation,
): boolean {
  if (mutation.status !== "succeeded") {
    return false;
  }
  if (mutation.desiredState === "archived") {
    return session.archivedAt !== undefined;
  }
  return session.archivedAt === undefined;
}

function reconcileArchiveMutation(
  session: ChatSession,
  mutation: ArchiveSessionMutation,
  confirmed: boolean,
): ChatSession {
  if (confirmed) {
    return session;
  }
  // Local intent wins over conflicting ACP list data; ACP does not expose a
  // version that distinguishes stale pages from another client flipping state.
  return {
    ...session,
    archivedAt:
      mutation.desiredState === "archived"
        ? mutation.optimisticArchivedAt
        : undefined,
  };
}

export function mergeAcpSessionPage(
  state: Pick<SessionPageState, "sessions" | "archiveMutationBySessionId">,
  page: AcpSessionsPage,
  previousCursor: string | null,
): SessionPageState {
  const { nextCursor } = page;
  const repeatedCursor =
    nextCursor != null &&
    previousCursor != null &&
    nextCursor === previousCursor;
  if (repeatedCursor) {
    console.warn(
      "ACP session/list returned the same pagination cursor; stopping pagination to avoid an infinite loop.",
    );
  }
  const hasMoreSessions = nextCursor != null && !repeatedCursor;
  const merged = mergeSessionMetadata(
    state.sessions,
    page.sessions.map(acpSessionToChatSession),
    state.archiveMutationBySessionId,
  );

  return {
    sessions: merged.sessions,
    archiveMutationBySessionId: merged.archiveMutationBySessionId,
    sessionPageCursor: hasMoreSessions ? nextCursor : null,
    hasMoreSessions,
  };
}
