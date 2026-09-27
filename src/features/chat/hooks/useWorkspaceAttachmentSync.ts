import { useEffect } from "react";
import {
  type ActiveWorkspace,
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import {
  loadPersistedChatWorkspaceMetadata,
  type PersistedChatWorkspaceMetadata,
  subscribeToChatWorkspaceMetadata,
} from "@/features/chat/stores/workspaceAttachmentPersistence";

function sameActiveWorkspace(
  left: ActiveWorkspace | undefined,
  right: ActiveWorkspace | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.path === right.path && left.branch === right.branch;
}

/**
 * Whether the session already holds this metadata. The store writes a
 * session's workspace fields itself before persisting them, so the change
 * notice that follows usually finds nothing left to apply; replacing the
 * session anyway re-rendered the sidebar a second time for the same change.
 * Attachments are compared by their text, which errs toward "changed".
 */
function sessionHoldsMetadata(
  session: ChatSession,
  metadata: PersistedChatWorkspaceMetadata,
): boolean {
  return (
    session.activeWorkspaceId === (metadata.activeWorkspaceId ?? null) &&
    session.workingDir === (metadata.workingDir ?? session.workingDir) &&
    JSON.stringify(session.workspaceAttachments) ===
      JSON.stringify(metadata.workspaceAttachments)
  );
}

/** Keeps renderer-local session stores aligned through per-session updates. */
export function useWorkspaceAttachmentSync(): void {
  useEffect(
    () =>
      subscribeToChatWorkspaceMetadata((changedSessionIds) => {
        if (!changedSessionIds) return;
        const changed = new Set(changedSessionIds);
        useChatSessionStore.setState((state) => {
          const activeWorkspaceBySession = {
            ...state.activeWorkspaceBySession,
          };
          for (const sessionId of changed) {
            const metadata = loadPersistedChatWorkspaceMetadata(sessionId);
            const active = activeWorkspaceBySession[sessionId];
            if (
              active &&
              !metadata?.workspaceAttachments.some(
                (attachment) => attachment.path === active.path,
              )
            ) {
              delete activeWorkspaceBySession[sessionId];
            }
          }
          let sessionsChanged = false;
          const sessions = state.sessions.map((session) => {
            if (!changed.has(session.id)) return session;
            const metadata = loadPersistedChatWorkspaceMetadata(session.id);
            if (!metadata) {
              delete activeWorkspaceBySession[session.id];
              if (
                Array.isArray(session.workspaceAttachments) &&
                session.workspaceAttachments.length === 0 &&
                session.activeWorkspaceId === null
              ) {
                return session;
              }
              sessionsChanged = true;
              return {
                ...session,
                workspaceAttachments: [],
                activeWorkspaceId: null,
              };
            }
            const activeAttachment = metadata.activeWorkspaceId
              ? metadata.workspaceAttachments.find(
                  (attachment) => attachment.id === metadata.activeWorkspaceId,
                )
              : undefined;
            if (activeAttachment) {
              activeWorkspaceBySession[session.id] = {
                path: activeAttachment.path,
                branch: activeAttachment.branch ?? null,
              };
            }
            if (sessionHoldsMetadata(session, metadata)) return session;
            sessionsChanged = true;
            return {
              ...session,
              workspaceAttachments: metadata.workspaceAttachments,
              activeWorkspaceId: metadata.activeWorkspaceId ?? null,
              workingDir: metadata.workingDir ?? session.workingDir,
            };
          });
          const activeChanged = [...changed].some(
            (sessionId) =>
              !sameActiveWorkspace(
                state.activeWorkspaceBySession[sessionId],
                activeWorkspaceBySession[sessionId],
              ),
          );
          if (!sessionsChanged && !activeChanged) return state;
          return {
            activeWorkspaceBySession: activeChanged
              ? activeWorkspaceBySession
              : state.activeWorkspaceBySession,
            sessions: sessionsChanged ? sessions : state.sessions,
          };
        });
      }),
    [],
  );
}
