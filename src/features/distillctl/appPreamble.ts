import {
  getDistillctlBrokerStatus,
  isPluginUnavailableError,
} from "@/features/distillctl/bridge/distillctlPlugin";

/**
 * App context preamble injected into every agent session while the distillctl
 * broker is running. It exists to make distillctl discoverable: the CLI is on
 * the harness's PATH (the agent host sets the shim and DISTILLCTL_BIN), but
 * nothing else ever tells the model it exists.
 *
 * Kept deliberately small (~85 tokens): nouns and verbs only — enough for
 * the model to route a request like "create a new chat" to
 * `distillctl session create` — with all argument detail deferred to `--help`.
 * The noun/verb lines are pinned against cli-surface.json by
 * appPreamble.test.ts so renames cannot drift silently; the listing is
 * intentionally non-exhaustive (niche verbs are omitted to save tokens).
 */
export const DISTILLCTL_PREAMBLE = `[Distill]
You are running inside Distill, a desktop app for working with agents.
A CLI named \`distillctl\` is on your PATH; it controls the Distill app itself.

Usage: distillctl <noun> <verb> [--json]
- session: create, send, open, list, get, rename, fork, archive, move
- folder: attach, detach, replace, set-cwd, list
- project: create, list, get, archive
- agent: create, list
- skill: create, list, get
- info: context, harnesses, models

Run \`distillctl <noun> <verb> --help\` for arguments. When asked to switch or move this chat to a new worktree/folder, use \`folder replace\` on the current cwd attachment so the old folder is removed from context. Use \`folder set-cwd\` to select an already attached folder, or only when the old folder should remain additional context. Use \`folder attach\` only to add context without changing cwd; \`folder detach\` removes context without deleting files.`;

/**
 * The preamble for one session: the shared text plus the session's own id.
 *
 * Nothing else tells an agent which session it is. The agent host runs one
 * bridge process per harness, so it cannot export a per-session env var
 * (AGENT_SESSION_ID stays unset), and `distillctl info context` reports the
 * chat the user is looking at, which need not be the caller's. distill-monitor
 * and any cross-session distillctl verb therefore need the id passed
 * explicitly, and this line is where the agent learns it.
 */
export function formatDistillctlPreamble(sessionId: string): string {
  const id = sessionId.trim();
  if (!id) return DISTILLCTL_PREAMBLE;
  return `${DISTILLCTL_PREAMBLE}

Your own session id is ${id}. Pass it explicitly as \`--session-id ${id}\` whenever a distillctl or distill-monitor command needs your session; there is no environment variable for it, \`distillctl info context\` reports the chat the user is viewing (not necessarily this one), and the working directory never identifies a session.`;
}

/** Set once an invoke rejection shows the plugin is not in this build or
 *  not granted; later sends skip the doomed IPC round-trip. */
let pluginUnavailable = false;

/**
 * The distillctl app preamble for `sessionId` when an agent can actually reach
 * the app, or `null` when it cannot (plugin off, broker not running).
 *
 * Availability is asked of the plugin per send rather than cached in the
 * renderer: the broker lifecycle runs in the main window, but popped-out
 * session windows also send prompts, and a renderer-local flag would never
 * be set there (each window is its own renderer). The plugin owns the
 * broker, so it is the one source of truth every window can query.
 */
export async function getDistillctlPreamble(
  sessionId: string,
): Promise<string | null> {
  if (pluginUnavailable || !window.__TAURI_INTERNALS__) {
    return null;
  }
  try {
    const { running } = await getDistillctlBrokerStatus();
    return running ? formatDistillctlPreamble(sessionId) : null;
  } catch (error) {
    if (isPluginUnavailableError(error)) {
      pluginUnavailable = true;
    } else {
      console.warn("[distillctl] failed to read broker status", error);
    }
    return null;
  }
}

/** Test-only: clear the cached plugin-unavailable state. */
export function __resetDistillctlPreambleForTests(): void {
  pluginUnavailable = false;
}
