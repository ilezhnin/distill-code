import { z } from "zod/v4";

import { DISTILLCTL_BOUNDS } from "../helpers";
import { defineCommand } from "../types";

const clearSessionProjectSchema = z
  .object({
    session_id: z
      .string()
      .max(DISTILLCTL_BOUNDS.id)
      .describe("Id of the session to move out of its project."),
  })
  .strict();

export const clearSessionProjectCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Move a chat session out of any project",
  description:
    "Move a chat session out of any project; the session list in the app regroups immediately.",
  helpFooter: `Example:
  distillctl session clear-project --session-id <session-id>

Result:
  {"ok": true} — the app's session list regroups immediately.`,
  schema: clearSessionProjectSchema,
  precheck: async (args) => {
    const { refuseRunningTarget } = await import("../runtime/sessions");
    refuseRunningTarget(args.session_id, "clear the project for");
  },
  execute: async (args) => {
    const [
      { moveSessionToProject },
      { loadSessionForDistillctl, requireSession },
    ] = await Promise.all([
      import("@/features/chat/stores/chatSessionOperations"),
      import("../runtime/sessions"),
    ]);
    await loadSessionForDistillctl(args.session_id);
    requireSession(args.session_id);
    await moveSessionToProject(args.session_id, null);
    return { ok: true as const };
  },
});
