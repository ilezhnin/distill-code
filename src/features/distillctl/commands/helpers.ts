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
export const DISTILLCTL_BOUNDS = {
  /** Opaque ids the caller echoes back from a list/get result. */
  id: 200,
  /** Titles, project/agent/skill names — one line in app UI. */
  name: 200,
  /** A skill's one-line "what and when" description. */
  shortText: 1_024,
  /** A search substring. */
  query: 500,
  /** A filesystem path (Windows MAX_PATH long-path form is 32 767, but no
   *  Distill-managed folder approaches that; 4096 matches POSIX PATH_MAX). */
  path: 4_096,
  /** Prose the app stores and replays into prompts: project instructions,
   *  persona system prompts, SKILL.md bodies. */
  document: 256 * 1_024,
  /** Elements in a repeated flag's array. */
  listLength: 32,
} as const;

/** Truncate with an ellipsis; shared by previews/summaries/message bodies. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export const sessionNotFoundMessage = (id: string) =>
  `No session "${id}"; list sessions with \`distillctl session list\`.`;

export const backendArchiveFailedMessage = (
  kind: "session" | "project",
  id: string,
) =>
  `The app backend refused to archive "${id}"; confirm the id with \`distillctl ${kind} list\` and retry.`;
