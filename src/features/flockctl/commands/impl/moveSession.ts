import { z } from "zod/v4";

import { FLOCKCTL_BOUNDS } from "../helpers";
import { defineCommand } from "../types";

const moveSessionSchema = z
  .object({
    session_id: z
      .string()
      .max(FLOCKCTL_BOUNDS.id)
      .describe("Id of the session to move."),
    project_id: z
      .string()
      .max(FLOCKCTL_BOUNDS.id)
      .describe("Id of the destination project."),
  })
  .strict();

export const moveSessionCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Move a chat session into a project",
  description:
    "Move a chat session into a project; the session list in the app regroups immediately.",
  helpFooter: `Example:
  flockctl session move --session-id <session-id> --project-id <project-id>

Result:
  {"ok": true} — the app's session list regroups immediately.`,
  schema: moveSessionSchema,
  precheck: async (args) => {
    const { refuseRunningTarget } = await import("../runtime/sessions");
    refuseRunningTarget(args.session_id, "move");
  },
  execute: async (args) => {
    const [
      { moveSessionToProject },
      { findProjectOrThrow },
      { loadSessionForFlockctl, requireSession },
    ] = await Promise.all([
      import("@/features/chat/stores/chatSessionOperations"),
      import("../runtime/projects"),
      import("../runtime/sessions"),
    ]);
    await Promise.all([
      loadSessionForFlockctl(args.session_id),
      findProjectOrThrow(args.project_id),
    ]);
    requireSession(args.session_id);
    await moveSessionToProject(args.session_id, args.project_id);
    return { ok: true as const };
  },
});
