import { z } from "zod/v4";

import type { CommandFailureReason } from "../../navigation";
import {
  BERDCTL_BOUNDS,
  backendArchiveFailedMessage,
  sessionNotFoundMessage,
} from "../helpers";
import { CommandError, defineCommand } from "../types";

const archiveSessionSchema = z
  .object({
    session_id: z
      .string()
      .max(BERDCTL_BOUNDS.id)
      .describe("Id of the session to archive."),
    // Kept on the wire for CLI compatibility only. berdctl can no longer
    // discard local work: the broker is unauthenticated, so any same-user
    // process could otherwise force-remove a dirty worktree. The flag is
    // accepted and ignored; the cleanup policy below is always "reject".
    discard_changes: z
      .boolean()
      .optional()
      .describe(
        "No effect; kept for compatibility. berdctl never discards local files or changes: when Git cleanup would, the command refuses and the user must confirm in the app.",
      ),
  })
  .strict();

export const archiveSessionCommand = defineCommand({
  effect: "archive",
  visibility: "immediate",
  destructive: false,
  summary: "Archive a chat and clean up its Distill-managed Git resources",
  description:
    "Archive a chat session, then remove eligible Distill-managed worktrees and branches. Refuses when cleanup would discard local files or changes; the user must confirm that in the app.",
  helpFooter: `The command refuses to archive when Git cleanup would discard local files or changes,
and berdctl cannot override that: only the user can confirm the loss, in the app.
--discard-changes is accepted for compatibility and has no effect. The command
never opens an interactive prompt.

Example:
  berdctl session archive --session-id <session-id>

Result:
  {"ok": true} — the session was archived and eligible worktrees and branches were removed.`,
  bridgeTimeoutMs: 150_000,
  schema: archiveSessionSchema,
  precheck: async (args) => {
    const { refuseRunningTarget } = await import("../runtime/sessions");
    refuseRunningTarget(args.session_id, "archive");
  },
  execute: async (args, ctx) => {
    const [{ getAppNavigationController }, { loadSessionForBerdctl }] =
      await Promise.all([
        import("../../navigation"),
        import("../runtime/sessions"),
      ]);
    await loadSessionForBerdctl(args.session_id);
    // Always "reject": berdctl has no way to obtain the user's consent to
    // lose work, so cleanup that would discard anything is refused with
    // cleanup_requires_discard regardless of the flag.
    const outcome = await getAppNavigationController().archiveSession(
      args.session_id,
      "reject",
      ctx.deadlineMs,
    );
    if (!outcome.ok) {
      throw new CommandError(
        outcome.reason,
        archiveFailureMessage(args.session_id, outcome.reason),
      );
    }
    if (outcome.cleanupIncomplete) {
      throw new CommandError(
        outcome.cleanupIncomplete,
        archiveCleanupIncompleteMessage(
          args.session_id,
          outcome.cleanupIncomplete,
        ),
      );
    }
    return { ok: true as const };
  },
});

function archiveCleanupIncompleteMessage(
  sessionId: string,
  reason: "target_session_running" | "workspace_cleanup_failed" | "timed_out",
): string {
  switch (reason) {
    case "target_session_running":
      return `Session "${sessionId}" was archived, but Git cleanup stopped because the session started running or opened in another window; inspect the worktrees and branches in the app.`;
    case "workspace_cleanup_failed":
      return `Session "${sessionId}" was archived, but Git cleanup could not finish; inspect the worktrees and branches in the app.`;
    case "timed_out":
      return `Session "${sessionId}" was archived, but Git cleanup reached the command deadline before the next mutation could start; inspect the worktrees and branches in the app.`;
    default:
      reason satisfies never;
      return `Session "${sessionId}" was archived, but Git cleanup could not finish (${String(reason)}).`;
  }
}

/** Reason-specific failure messages, relayed verbatim by the CLI. */
function archiveFailureMessage(
  sessionId: string,
  reason: CommandFailureReason,
): string {
  switch (reason) {
    case "session_not_found":
      return sessionNotFoundMessage(sessionId);
    case "backend_archive_failed":
      return backendArchiveFailedMessage("session", sessionId);
    case "target_session_running":
      return `Refusing to archive session "${sessionId}" because it started running or opened in another window; wait for the turn to finish or close that window.`;
    case "cleanup_requires_discard":
      return `Refusing to archive session "${sessionId}" because Git cleanup would discard local files or changes; berdctl cannot discard them. Ask the user to archive the chat in the app, where they can confirm the loss.`;
    case "git_inspection_failed":
      return `Could not inspect the worktrees or branches for session "${sessionId}"; the session was not archived.`;
    case "workspace_cleanup_failed":
      return `Session "${sessionId}" was archived, but Git cleanup could not finish; inspect the worktrees and branches in the app.`;
    case "timed_out":
      return `Archiving session "${sessionId}" timed out before the next mutation could start.`;
    case "blocked_unsaved_changes":
      return `Failed to archive session "${sessionId}" (${reason})`;
    default:
      reason satisfies never;
      return `Failed to archive session "${sessionId}" (${String(reason)})`;
  }
}
