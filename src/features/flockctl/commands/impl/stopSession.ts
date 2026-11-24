import { z } from "zod/v4";

import { FLOCKCTL_BOUNDS, sessionTokenField } from "../helpers";
import { CommandError, defineCommand } from "../types";

const singleLine = (what: string) =>
  z
    .string()
    .trim()
    .min(1)
    .regex(/^[^\r\n]*$/, `${what} must be a single line.`);

const stopSessionSchema = z
  .object({
    session_id: z
      .string()
      .max(FLOCKCTL_BOUNDS.id)
      .describe(
        "Id of the session to stop: one started under another chat (from `flockctl session create`).",
      ),
    reason: singleLine("Reason")
      .max(300)
      .optional()
      .describe(
        "Optional reason shown on the stopped session's chip (1-300 chars).",
      ),
    from: singleLine("Sender label")
      .max(120)
      .optional()
      .describe("Optional visible name of who stopped it (1-120 chars)."),
    session_token: sessionTokenField("the chat that started this session"),
  })
  .strict();

/**
 * What the chip says about a stop made through flockctl: who, when the call
 * named itself, and why, when it said. The operator must never find a stopped
 * agent and not know whether they or another chat did it.
 */
export function flockctlStopReason(args: {
  reason?: string;
  from?: string;
}): string {
  const who = args.from
    ? `Stopped by ${args.from}`
    : "Stopped through flockctl";
  return args.reason ? `${who}: ${args.reason}` : who;
}

export const stopSessionCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Stop a session another chat started: end its turn, drop its queue",
  description:
    "Stop a session that was started under another chat, the same way its chip's " +
    "stop control does: its queued messages are dropped and its running turn is " +
    "cancelled. A turn whose agent does not answer the cancel (a provider out of " +
    "quota, an agent that stopped responding) is ended by the app shortly after. " +
    "Its files and its chat are kept; the chip shows it stopped, by whom and why. " +
    "Sessions not started under another chat are refused: stop those in the app. " +
    "A session can only stop sessions it started, directly or under one of its " +
    "own: from an agent's shell the call needs the starting chat's --session-token.",
  helpFooter: `Example:
  flockctl session stop --session-id <child-session-id> --session-token <your-session-token> \\
    --from "Parent chat" --reason "provider out of quota"

Result:
  {"ok": true, "session_id": "...", "outcome": "stopped"|"already_finished"}
  "stopped": the session was working or had queued messages; it was told to stop.
  "already_finished": it had already finished, failed or been stopped; nothing changed.
  Refused with "spawn_not_allowed" for an agent that did not start the session.`,
  schema: stopSessionSchema,
  execute: async (args, ctx) => {
    const [
      { useConductorGraphStore },
      { isWorkingStatus },
      { stopOrchestratorSession },
      { useChatStore },
      { isSessionRunning },
      {
        isInSessionTree,
        resolveFlockctlCaller,
        TOKEN_NOT_THIS_APPS,
        TOKEN_WHERE,
      },
      { resetPersonaHandoff },
    ] = await Promise.all([
      import("@/features/conductor/conductorGraphStore"),
      import("@/features/conductor/brigadeActivity"),
      import("@/features/conductor/orchestratorControls"),
      import("@/features/chat/stores/chatStore"),
      import("@/features/chat/lib/sessionActivity"),
      import("../runtime/spawnGate"),
      import("@/shared/api/acpPersonaHandoff"),
    ]);
    const node = useConductorGraphStore.getState().getNode(args.session_id);
    if (!node?.parentSessionId) {
      throw new CommandError(
        "invalid_args",
        `Session "${args.session_id}" was not started under another chat; flockctl only stops sessions a chat started. Ask the user to stop it in the app.`,
      );
    }
    // Same rule as starting one: a session may only act on the sessions it
    // started. The rule used to read the harness's own actor alone, which
    // the built-in host never sends, so from that host it applied to nobody
    // and any agent could stop any chat's child. An agent's call now proves
    // its session with the token `session create` takes.
    const caller = await resolveFlockctlCaller({
      actor: ctx.actor,
      fromAgent: ctx.fromAgent,
      sessionToken: args.session_token,
    });
    if (caller.kind === "bad-token") {
      throw new CommandError("spawn_not_allowed", TOKEN_NOT_THIS_APPS);
    }
    if (caller.kind === "unproven") {
      // The starting chat may be the caller with its context compacted
      // away: its next message carries the context, and the token, again.
      resetPersonaHandoff(node.parentSessionId);
      throw new CommandError(
        "spawn_not_allowed",
        `This call comes from an agent's shell and does not prove which session makes it, so it is not read as the operator's: a session can only stop the sessions it started. ${TOKEN_WHERE} If you started session "${args.session_id}" and no longer have the token, the app sends that context again with the next message your chat receives.`,
      );
    }
    // What a session starts through a script hangs where the work is, under
    // one of its own executors, so "started" reaches down its tree.
    if (
      caller.kind === "session" &&
      !isInSessionTree(node.parentSessionId, caller.sessionId)
    ) {
      throw new CommandError(
        "spawn_not_allowed",
        `Session "${args.session_id}" was started by another chat; a session can only stop the sessions it started.`,
      );
    }
    const chat = useChatStore.getState();
    const working =
      isWorkingStatus(node.status) ||
      isSessionRunning(
        chat.sessionStateById[node.sessionId]?.chatState ?? "idle",
      ) ||
      (chat.queuedMessageBySession[node.sessionId]?.length ?? 0) > 0;
    if (!working) {
      return {
        ok: true as const,
        session_id: node.sessionId,
        outcome: "already_finished" as const,
      };
    }
    await stopOrchestratorSession(node.sessionId, flockctlStopReason(args));
    return {
      ok: true as const,
      session_id: node.sessionId,
      outcome: "stopped" as const,
    };
  },
});
