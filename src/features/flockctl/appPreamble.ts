import {
  getFlockctlBrokerStatus,
  isPluginUnavailableError,
} from "@/features/flockctl/bridge/flockctlPlugin";

/**
 * App context preamble injected into every agent session while the flockctl
 * broker is running. It exists to make flockctl discoverable: the CLI is on
 * the harness's PATH (the agent host sets the shim and FLOCKCTL_BIN), but
 * nothing else ever tells the model it exists.
 *
 * Kept deliberately small (~85 tokens): nouns and verbs only — enough for
 * the model to route a request like "create a new chat" to
 * `flockctl session create` — with all argument detail deferred to `--help`.
 * The noun/verb lines are pinned against cli-surface.json by
 * appPreamble.test.ts so renames cannot drift silently; the listing is
 * intentionally non-exhaustive (niche verbs are omitted to save tokens).
 */
export const FLOCKCTL_PREAMBLE = `[Flock]
You are running inside Levocat Flock, a desktop app for working with agents.
A CLI named \`flockctl\` is on your PATH; it controls the Flock app itself.

Usage: flockctl <noun> <verb> [--json]
- session: create, send, open, list, get, rename, fork, archive, move
- folder: attach, detach, replace, set-cwd, list
- project: create, list, get, archive
- agent: create, list
- skill: create, list, get
- wave: list, get, validate, cancel, steer, amend, skip, restart, roadmap
- info: context, harnesses, models

Run \`flockctl <noun> <verb> --help\` for arguments. When asked to switch or move this chat to a new worktree/folder, use \`folder replace\` on the current cwd attachment so the old folder is removed from context. Use \`folder set-cwd\` to select an already attached folder, or only when the old folder should remain additional context. Use \`folder attach\` only to add context without changing cwd; \`folder detach\` removes context without deleting files.`;

/**
 * The preamble for one session: the shared text plus the session's own id.
 *
 * Nothing else tells an agent which session it is. The agent host runs one
 * bridge process per harness, so it cannot export a per-session env var
 * (AGENT_SESSION_ID stays unset), and `flockctl info context` reports the
 * chat the user is looking at, which need not be the caller's. flock-monitor
 * and any cross-session flockctl verb therefore need the id passed
 * explicitly, and this line is where the agent learns it.
 *
 * The same id is what makes a session this one starts its child: without
 * `--parent-session-id` the app cannot tell who started it, and the helper
 * lands in the sidebar as an unrelated chat whose result nobody delivers.
 *
 * An id is a claim anyone can type, so a session that may start others is
 * also told its token (`sessionToken.ts`): the proof the spawn gate asks
 * of a call made from an agent's shell. A session that starts nobody is
 * told none.
 *
 * The token is the session's to delegate, and the text says so. It first
 * said the token was "no other session's to use": a conductor read that
 * as a ban on handing it to its own dispatcher script, refused, and asked
 * the operator to run the script from a terminal (11-16).
 */
export function formatFlockctlPreamble(
  sessionId: string,
  maySpawn = true,
  sessionToken?: string | null,
): string {
  const id = sessionId.trim();
  if (!id) return FLOCKCTL_PREAMBLE;
  // A session whose layer starts nobody is told so here too. This line
  // used to invite every session to start others, beside a spawn rule
  // that forbade it: a worker read both and learned which held from
  // `spawn_not_allowed` (11-14).
  const spawning = maySpawn
    ? sessionToken
      ? `When you start a session to take on part of your work, pass \`--parent-session-id ${id} --session-token ${sessionToken}\` to \`flockctl session create\`: it is shown under this chat, and its result is delivered back here when its turn ends. Omit \`--parent-session-id\` only for an independent chat the user asked for. The token is how the app knows a call is made for you: \`session create\` and \`session fork\` run from an agent's shell are refused without it. It is yours to delegate: a script or background process you start to do your work (a dispatcher, a runner) needs no change, set \`FLOCK_SESSION_TOKEN=${sessionToken}\` in its environment and every \`flockctl\` it runs carries it, so the sessions it starts are started as you. Such a session may hang under you or under a session you started (\`--parent-session-id\`). Never ask the user to run something from their own terminal because of the token.`
      : `When you start a session to take on part of your work, pass \`--parent-session-id ${id}\` to \`flockctl session create\`: it is shown under this chat, and its result is delivered back here when its turn ends. Omit it only for an independent chat the user asked for.`
    : `This session starts no other sessions: \`flockctl session create\` and \`flockctl session fork\` are not yours to run, under your own id or another chat's. If the work needs more hands than you have, say so in your report (\`needsOperator\`, \`nextSuggestedTask\`) and the chat that gave you the task decides.`;
  return `${FLOCKCTL_PREAMBLE}

Your own session id is ${id}. Pass it explicitly as \`--session-id ${id}\` whenever a flockctl or flock-monitor command needs your session; there is no environment variable for it, \`flockctl info context\` without --session-id reports the chat the user is viewing (not necessarily this one), and the working directory never identifies a session. \`flockctl wave list --conductor-session-id ${id}\` lists the waves this chat planned with the session running each step.
${spawning}`;
}

/** Set once an invoke rejection shows the plugin is not in this build or
 *  not granted; later sends skip the doomed IPC round-trip. */
let pluginUnavailable = false;

/**
 * The flockctl app preamble for `sessionId` when an agent can actually reach
 * the app, or `null` when it cannot (plugin off, broker not running).
 *
 * Availability is asked of the plugin per send rather than cached in the
 * renderer: the broker lifecycle runs in the main window, but popped-out
 * session windows also send prompts, and a renderer-local flag would never
 * be set there (each window is its own renderer). The plugin owns the
 * broker, so it is the one source of truth every window can query.
 */
export async function getFlockctlPreamble(
  sessionId: string,
  personaId?: string | null,
): Promise<string | null> {
  if (pluginUnavailable || !window.__TAURI_INTERNALS__) {
    return null;
  }
  try {
    const { running } = await getFlockctlBrokerStatus();
    if (!running) return null;
    const [{ sessionMaySpawn }, { sessionTokenFor }] = await Promise.all([
      import("@/features/conductor/spawnAcl"),
      import("./sessionToken"),
    ]);
    const maySpawn = sessionMaySpawn(sessionId, personaId);
    return formatFlockctlPreamble(
      sessionId,
      maySpawn,
      maySpawn ? await sessionTokenFor(sessionId) : null,
    );
  } catch (error) {
    if (isPluginUnavailableError(error)) {
      pluginUnavailable = true;
    } else {
      console.warn("[flockctl] failed to read broker status", error);
    }
    return null;
  }
}

/** Test-only: clear the cached plugin-unavailable state. */
export function __resetFlockctlPreambleForTests(): void {
  pluginUnavailable = false;
}
