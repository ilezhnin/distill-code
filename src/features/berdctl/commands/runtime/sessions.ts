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
  type AcpSessionInfo,
  type AcpSessionsPage,
} from "@/shared/api/acp";
import { sessionNotFoundMessage } from "../helpers";
import { CommandError } from "../types";
import { DEFAULT_HARNESS_ID } from "@/features/providers/curatedProviders";

/** The host's own rows from the last read, keyed by session id. */
export type HostSessionInfoById = Map<string, AcpSessionInfo>;

/** Walks the whole session table. Only for reads that genuinely need it —
 *  `project get` counts a project's sessions and resolves group membership. */
export async function loadAllSessionsForBerdctl(): Promise<HostSessionInfoById> {
  return loadSessionsForBerdctl(null);
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
): Promise<HostSessionInfoById> {
  return loadSessionsForBerdctl(rowLimit);
}

async function loadSessionsForBerdctl(
  rowLimit: number | null,
): Promise<HostSessionInfoById> {
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
    // The chat store has no place for the host's acknowledged run settings of
    // a chat nobody opened, so the rows this read fetched are handed back to
    // the command that asked for them instead.
    return new Map(
      pages.flatMap(({ page }) =>
        page.sessions.map((session) => [session.sessionId, session] as const),
      ),
    );
  } catch (error) {
    throw new CommandError(
      "backend_read_failed",
      `Failed to read sessions from the app backend: ${String(error)}`,
    );
  }
}

export async function loadSessionForBerdctl(
  sessionId: string,
): Promise<AcpSessionInfo> {
  try {
    const session = await acpGetSessionInfo(sessionId);
    useChatSessionStore.setState((state) =>
      mergeAcpSessionInfo(state, session),
    );
    return session;
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

/**
 * Refuses a berdctl mutation that would hide a chat still running shells.
 *
 * Archiving a chat in the app stops its terminals, because a shell under a
 * chat that has left the sidebar is a process with no UI to stop it. That is
 * an unrecoverable loss — a dev server, a build, a migration — and unarchiving
 * restores nothing, so only the operator may cause it. berdctl is declared
 * non-destructive and its help promises it never discards local work, so it
 * archives without the stop and refuses while shells are live instead of
 * leaving orphans behind.
 */
export async function refuseChatWithLiveTerminals(
  sessionId: string,
  verb: string,
): Promise<void> {
  const { getChatSessionIdsWithTerminals } = await import(
    "@/features/terminal/lib/terminalSessionManager"
  );
  if (!getChatSessionIdsWithTerminals().has(sessionId)) {
    return;
  }
  throw new CommandError(
    "session_has_terminals",
    `Refusing to ${verb} session "${sessionId}" because it still has running terminals; archiving hides the chat and berdctl will not stop the shells. Ask the user to close the terminals, or to archive the chat in the app.`,
  );
}

export function sessionMetadata(
  session: ChatSession,
  hostSession?: AcpSessionInfo,
) {
  const runtime = useChatStore.getState().getSessionRuntime(session.id);
  return {
    session_id: session.id,
    title: session.title,
    harness_id: session.executionTarget?.harnessId ?? DEFAULT_HARNESS_ID,
    model_id: session.executionTarget?.modelId ?? null,
    // The host's value is what the bridge last acknowledged for this chat, so
    // it answers even for a chat nobody has opened in this window. The
    // window's live menu only fills in for a host that does not say.
    effort:
      hostSession?.reasoningEffort ??
      session.reasoningEffort?.currentValue ??
      null,
    fast_mode: hostSession?.fastMode ?? session.fastMode?.enabled ?? null,
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
