import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import {
  mergeAcpSessionInfo,
  mergeAcpSessionPage,
} from "@/features/chat/lib/acpSessionMapping";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  acpGetSessionInfo,
  acpListSessionsPage,
  type AcpSessionsPage,
} from "@/shared/api/acp";
import { sessionNotFoundMessage } from "../helpers";
import { CommandError } from "../types";
import { DEFAULT_HARNESS_ID } from "@/features/providers/curatedProviders";

/** Walks the whole session table. Only for reads that genuinely need it —
 *  `project get` counts a project's sessions and resolves group membership. */
export async function loadAllSessionsForBerdctl(): Promise<void> {
  await loadSessionsForBerdctl(null);
}

/**
 * Loads only as much of the session table as a `--limit`ed list can show:
 * paging stops once `rowLimit` unarchived rows have been fetched.
 *
 * Safe because the host pages `ORDER BY updated_at DESC` and the renderer
 * ranks by last activity, which a session's `updated_at` always covers — a
 * session cannot rank above one we already fetched without having been
 * updated more recently. Only for an unfiltered list: a `--query` or
 * `--project-id` match can sit on any page, so those still need the full
 * table.
 */
export async function loadRecentSessionsForBerdctl(
  rowLimit: number,
): Promise<void> {
  await loadSessionsForBerdctl(rowLimit);
}

async function loadSessionsForBerdctl(rowLimit: number | null): Promise<void> {
  try {
    const pages: Array<{
      page: AcpSessionsPage;
      previousCursor: string | null;
    }> = [];
    let cursor: string | null = null;
    let previousCursor: string | null = null;
    let unarchivedRows = 0;

    for (;;) {
      const page = await acpListSessionsPage({ cursor });
      pages.push({ page, previousCursor });
      unarchivedRows += page.sessions.filter(
        (session) => session.archivedAt == null,
      ).length;
      const nextCursor = page.nextCursor ?? null;
      // The same guard mergeAcpSessionPage applies when it computes
      // hasMoreSessions: a host that keeps handing back the cursor it was
      // given must not spin this loop forever.
      if (!nextCursor || nextCursor === previousCursor) break;
      if (rowLimit != null && unarchivedRows >= rowLimit) break;
      previousCursor = nextCursor;
      cursor = nextCursor;
    }

    // One setState for all pages. The sidebar subscribes to this store, so a
    // write per page made every `berdctl session list` cost one full sidebar
    // re-render per 200 sessions — visible as composer jank while an agent
    // polls and the operator types. Folding inside the updater, over the
    // state as it is at commit time rather than a snapshot taken before the
    // awaits, keeps the per-page merge semantics unchanged.
    useChatSessionStore.setState((state) => {
      let merged: ReturnType<typeof mergeAcpSessionPage> = {
        sessions: state.sessions,
        archiveMutationBySessionId: state.archiveMutationBySessionId,
        sessionPageCursor: state.sessionPageCursor,
        hasMoreSessions: state.hasMoreSessions,
      };
      for (const entry of pages) {
        merged = mergeAcpSessionPage(merged, entry.page, entry.previousCursor);
      }
      return { ...merged, hasHydratedSessions: true, isLoading: false };
    });
  } catch (error) {
    throw new CommandError(
      "backend_read_failed",
      `Failed to read sessions from the app backend: ${String(error)}`,
    );
  }
}

export async function loadSessionForBerdctl(sessionId: string): Promise<void> {
  try {
    const session = await acpGetSessionInfo(sessionId);
    useChatSessionStore.setState((state) =>
      mergeAcpSessionInfo(state, session),
    );
  } catch (error) {
    if (isAcpResourceNotFound(error)) {
      throw new CommandError(
        "session_not_found",
        sessionNotFoundMessage(sessionId),
      );
    }
    throw new CommandError(
      "backend_read_failed",
      `Failed to read session from the app backend: ${String(error)}`,
    );
  }
}

function isAcpResourceNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === -32002
  );
}

export function requireSession(sessionId: string): ChatSession {
  const session = useChatSessionStore.getState().getSession(sessionId);
  if (!session) {
    throw new CommandError(
      "session_not_found",
      sessionNotFoundMessage(sessionId),
    );
  }
  return session;
}

export function refuseRunningTarget(sessionId: string, verb: string): void {
  const runtime = useChatStore.getState().getSessionRuntime(sessionId);
  if (isSessionRunning(runtime.chatState) || runtime.isRunCancellationPending) {
    throw new CommandError(
      "target_session_running",
      `Refusing to ${verb} session "${sessionId}" while its agent is running or cancellation is pending; wait for the turn to finish or ask the user.`,
    );
  }
}

export function sessionMetadata(session: ChatSession) {
  const runtime = useChatStore.getState().getSessionRuntime(session.id);
  return {
    session_id: session.id,
    title: session.title,
    harness_id: session.executionTarget?.harnessId ?? DEFAULT_HARNESS_ID,
    model_id: session.executionTarget?.modelId ?? null,
    agent_id: session.personaId ?? null,
    project_id: session.projectId ?? null,
    working_dir: session.workingDir ?? null,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    archived: session.archivedAt != null,
    is_running:
      isSessionRunning(runtime.chatState) || runtime.isRunCancellationPending,
    // Kept in the berdctl result shape; sessions only ever live in the main
    // window now that pop-out session windows are gone.
    is_open_in_window: false,
    chat_state: runtime.chatState,
    message_count: session.messageCount,
  };
}
