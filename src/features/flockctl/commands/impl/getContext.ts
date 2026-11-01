import { z } from "zod/v4";

import { FLOCKCTL_BOUNDS } from "../helpers";
import { defineCommand } from "../types";

const getContextSchema = z
  .object({
    session_id: z
      .string()
      .trim()
      .min(1)
      .max(FLOCKCTL_BOUNDS.id)
      .optional()
      .describe(
        "Your own session id (the Flock preamble states it). With it the " +
          "result describes that session — its project, working folder, " +
          "parent chat and wave — instead of the chat the user is viewing.",
      ),
  })
  .strict();

interface GetContextResult {
  view: string;
  active_session_id: string | null;
  active_project_id: string | null;
  app_version: string;
  /** The caller's session, when the call named one. */
  session: {
    session_id: string;
    title: string;
    project_id: string | null;
    working_dir: string | null;
    parent_session_id: string | null;
    root_conductor_id: string | null;
    wave_id: string | null;
    wave_step: number | null;
    role: string | null;
  } | null;
}

export const getContextCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "Read what the user is looking at, or the caller's own context",
  description:
    "Read the app's current context: which view and session the user is " +
    "looking at, the active session's project, and the app version; does " +
    "not change anything on screen. With --session-id, also describe that " +
    "session — the caller's own, usually — rather than only the viewed chat.",
  helpFooter: `Example:
  flockctl info context --session-id <your-session-id> --json

Result:
  {"view": "...", "active_session_id": "..."|null,
   "active_project_id": "..."|null, "app_version": "...",
   "session": null|{"session_id": "...", "title": "...", "project_id": "..."|null,
                    "working_dir": "..."|null, "parent_session_id": "..."|null,
                    "root_conductor_id": "..."|null, "wave_id": "..."|null,
                    "wave_step": 1|null, "role": "conductor"|"worker"|...|null}}
  "active_*" describe the chat the user is viewing, which need not be the
  caller's; "session" describes the session named with --session-id.`,
  schema: getContextSchema,
  execute: async (args, ctx): Promise<GetContextResult> => {
    const [
      { default: packageJson },
      { getAppNavigationController },
      { useChatSessionStore },
      { useConductorGraphStore },
    ] = await Promise.all([
      import("../../../../../package.json"),
      import("../../navigation"),
      import("@/features/chat/stores/chatSessionStore"),
      import("@/features/conductor/conductorGraphStore"),
    ]);
    const context = getAppNavigationController().getAppContext();
    // The caller's session: the one it named, else the actor the harness
    // exported, when it did. Never the viewed chat — that is what "active_*"
    // already say, and a default to it is how a cross-session command lands
    // in the wrong chat.
    const sessionId = args.session_id ?? ctx.actor;
    const session = sessionId
      ? useChatSessionStore.getState().getSession(sessionId)
      : undefined;
    const node = sessionId
      ? useConductorGraphStore.getState().getNode(sessionId)
      : undefined;
    return {
      view: context.view,
      active_session_id: context.activeSessionId,
      active_project_id: context.activeProjectId,
      // Match telemetry's resolution: prefer the build-injected version
      // (git-derived for non-release builds), fall back to package.json.
      app_version: import.meta.env.VITE_APP_VERSION ?? packageJson.version,
      session:
        sessionId && (session || node)
          ? {
              session_id: sessionId,
              title: session?.title ?? node?.displayName ?? "",
              project_id: session?.projectId ?? node?.projectId ?? null,
              working_dir: session?.workingDir ?? null,
              parent_session_id: node?.parentSessionId ?? null,
              root_conductor_id: node?.rootConductorId ?? null,
              wave_id: node?.waveId ?? null,
              wave_step:
                typeof node?.stepIndex === "number" ? node.stepIndex + 1 : null,
              role: node?.role ?? null,
            }
          : null,
    };
  },
});
