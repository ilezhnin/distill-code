import { z } from "zod/v4";

import { DISTILLCTL_BOUNDS } from "../helpers";
import { defineCommand, CommandError } from "../types";

const detachSessionFolderSchema = z
  .object({
    session_id: z
      .string()
      .min(1)
      .max(DISTILLCTL_BOUNDS.id)
      .describe("Id of the session to detach from."),
    path: z
      .string()
      .min(1)
      .max(DISTILLCTL_BOUNDS.path)
      .describe(
        "Existing attached folder, repository, or worktree path; ~ is expanded.",
      ),
  })
  .strict();

export const detachSessionFolderCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Detach a folder, repository, or worktree from a chat",
  description:
    "Remove an existing folder from chat context without deleting anything. If it is cwd, the chat safely falls back to the first remaining attachment or Distill's default cwd.",
  helpFooter: `Detach the checked-out folder to detach its branch from chat context. This does not delete anything from disk or Git.

Example:
  distillctl folder detach --session-id <session-id> --path ~/src/repo-worktrees/feature

Result:
  {"ok": true, "path": "...", "detached": true|false}`,
  schema: detachSessionFolderSchema,
  execute: async (args, ctx) => {
    const [
      { detachSessionFolder, FolderAttachmentError },
      { refusePastDeadline },
      { loadSessionForDistillctl },
    ] = await Promise.all([
      import("@/features/chat/lib/sessionFolderRegistration"),
      import("../runtime/deadline"),
      import("../runtime/sessions"),
    ]);
    await loadSessionForDistillctl(args.session_id);
    try {
      const result = await detachSessionFolder(args.session_id, args.path, {
        beforeMutation: () => {
          refusePastDeadline(ctx, "the folder was not detached");
        },
      });
      return { ok: true as const, ...result };
    } catch (error) {
      if (error instanceof FolderAttachmentError) {
        throw new CommandError("invalid_args", error.message);
      }
      throw error;
    }
  },
});
