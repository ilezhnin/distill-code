import { z } from "zod/v4";

/**
 * Length caps for the free-text wire fields (invariant 3: bounds live in zod,
 * clap only mirrors them).
 *
 * Every string field needs one. The broker's only other limit is axum's 2 MiB
 * body cap, which is not a product bound: without these a single call could
 * persist a ~1.9 MB session title into the host DB and the sidebar, or give a
 * persona a 1.9 MB system prompt that every later chat resends.
 * `bounds.test.ts` fails when a string field in TOOL_GROUPS declares no max.
 */
export const FLOCKCTL_BOUNDS = {
  /** Opaque ids the caller echoes back from a list/get result. */
  id: 200,
  /** Titles, project/agent/skill names — one line in app UI. */
  name: 200,
  /** A skill's one-line "what and when" description. */
  shortText: 1_024,
  /** A search substring. */
  query: 500,
  /** A filesystem path (Windows MAX_PATH long-path form is 32 767, but no
   *  Flock-managed folder approaches that; 4096 matches POSIX PATH_MAX). */
  path: 4_096,
  /** Prose the app stores and replays into prompts: project instructions,
   *  persona system prompts, SKILL.md bodies. */
  document: 256 * 1_024,
  /** Elements in a repeated flag's array. */
  listLength: 32,
} as const;

/**
 * The `--session-token` field of a command that acts on what one session
 * owns. The token is the one `session create` takes; `proves` says whose
 * call it has to be here. The CLI fills the field from FLOCK_SESSION_TOKEN
 * for every command that declares it (`wire.rs`).
 */
export function sessionTokenField(proves: string) {
  return z
    .string()
    .trim()
    .min(1)
    .max(FLOCKCTL_BOUNDS.id + 32)
    .optional()
    .describe(
      "Your session's token (the Flock preamble states it beside your " +
        `session id): the proof that the call is made by ${proves}. ` +
        "Required when the command runs in an agent session's shell; the " +
        "operator's own terminal needs none. A script you start reads it " +
        "from FLOCK_SESSION_TOKEN in its environment instead of the flag.",
    );
}

/** Truncate with an ellipsis; shared by previews/summaries/message bodies. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export const sessionNotFoundMessage = (id: string) =>
  `No session "${id}"; list sessions with \`flockctl session list\`.`;

export const backendArchiveFailedMessage = (
  kind: "session" | "project",
  id: string,
) =>
  `The app backend refused to archive "${id}"; confirm the id with \`flockctl ${kind} list\` and retry.`;
