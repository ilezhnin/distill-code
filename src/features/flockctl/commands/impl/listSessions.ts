import { z } from "zod/v4";

import { FLOCKCTL_BOUNDS } from "../helpers";
import { defineCommand } from "../types";

const listSessionsSchema = z
  .object({
    project_id: z
      .string()
      .max(FLOCKCTL_BOUNDS.id)
      .optional()
      .describe("Only list sessions belonging to this project."),
    query: z
      .string()
      .max(FLOCKCTL_BOUNDS.query)
      .optional()
      .describe("Case-insensitive substring to match against session titles."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe(
        "Maximum number of sessions to return (1-100). Defaults to 20.",
      ),
  })
  .strict();

interface ListSessionsResult {
  sessions: Array<{
    session_id: string;
    title: string;
    project_id: string | null;
    parent_session_id: string | null;
    wave_id: string | null;
    wave_step: number | null;
    effort: string | null;
    fast_mode: boolean | null;
    updated_at: string;
    is_running: boolean;
    chat_state:
      | "idle"
      | "thinking"
      | "streaming"
      | "waiting"
      | "compacting"
      | "error";
    message_count: number;
    provider_wait: {
      reason: "allowance_spent" | "rate_limited";
      until: string | null;
    } | null;
  }>;
}

export const listSessionsCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "List the user's chat sessions (most recent first)",
  description:
    "List the user's chat sessions visible in the app (most recent first); does not change anything on screen.",
  helpFooter: `Example:
  flockctl session list --query "review" --limit 10 --json

Result:
  {"sessions": [{"session_id": "...", "title": "...",
                 "project_id": "..."|null, "parent_session_id": "..."|null,
                 "wave_id": "..."|null, "wave_step": 1|null,
                 "effort": "..."|null, "fast_mode": true|false|null,
                 "updated_at": "...", "is_running": false,
                 "chat_state": "idle", "message_count": 12,
                 "provider_wait": {"reason": "...", "until": "..."|null}|null},
                ...]}
  Most recent first; archived sessions are excluded. "parent_session_id"
  is the chat the session was started under (a conductor, or the session
  that passed --parent-session-id); "wave_id" and "wave_step" are set for a
  wave's executors. "effort" and "fast_mode" are what each session's model
  last acknowledged; null means none was recorded and the model runs at its
  own default. "provider_wait" is set while a session's queue is held for
  its provider (see \`flockctl session get --help\`).`,
  schema: listSessionsSchema,
  execute: async (args): Promise<ListSessionsResult> => {
    const [
      { useChatSessionStore },
      { findProjectOrThrow },
      {
        loadAllSessionsForFlockctl,
        loadRecentSessionsForFlockctl,
        sessionMetadata,
      },
    ] = await Promise.all([
      import("@/features/chat/stores/chatSessionStore"),
      import("../runtime/projects"),
      import("../runtime/sessions"),
    ]);
    // Validate the project filter so a typo'd id errors instead of reading as
    // "this project has no sessions".
    if (args.project_id) {
      await findProjectOrThrow(args.project_id);
    }
    // A filter can match a session on any page, so those read the whole
    // table; an unfiltered list stops as soon as it has `limit` rows. Agents
    // (and flock-monitor's delivery loop) poll this command, and every page
    // costs an IPC round-trip plus a session-store write the sidebar renders.
    const hostSessions =
      args.project_id || args.query
        ? await loadAllSessionsForFlockctl()
        : await loadRecentSessionsForFlockctl(args.limit);
    const query = args.query?.toLowerCase();
    const sessions = useChatSessionStore
      .getState()
      .sessions.filter((session) => !session.archivedAt)
      .filter((session) =>
        args.project_id ? session.projectId === args.project_id : true,
      )
      .filter((session) =>
        query ? session.title.toLowerCase().includes(query) : true,
      )
      .slice(0, args.limit)
      .map((session) => {
        const metadata = sessionMetadata(session, hostSessions.get(session.id));
        return {
          session_id: session.id,
          title: session.title,
          project_id: session.projectId ?? null,
          parent_session_id: metadata.parent_session_id,
          wave_id: metadata.wave_id,
          wave_step: metadata.wave_step,
          effort: metadata.effort,
          fast_mode: metadata.fast_mode,
          updated_at: session.updatedAt,
          is_running: metadata.is_running,
          chat_state: metadata.chat_state,
          message_count: session.messageCount,
          provider_wait: metadata.provider_wait,
        };
      });
    return { sessions };
  },
});
