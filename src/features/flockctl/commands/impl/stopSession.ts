import { z } from "zod/v4";

import { FLOCKCTL_BOUNDS } from "../helpers";
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
    "Sessions not started under another chat are refused: stop those in the app.",
  helpFooter: `Example:
  flockctl session stop --session-id <child-session-id> --from "Parent chat" --reason "provider out of quota"

Result:
  {"ok": true, "session_id": "...", "outcome": "stopped"|"already_finished"}
  "stopped": the session was working or had queued messages; it was told to stop.
  "already_finished": it had already finished, failed or been stopped; nothing changed.`,
  schema: stopSessionSchema,
  execute: async (args, ctx) => {
    const [
      { useConductorGraphStore },
      { isWorkingStatus },
      { stopOrchestratorSession },
      { useChatStore },
      { isSessionRunning },
    ] = await Promise.all([
      import("@/features/conductor/conductorGraphStore"),
      import("@/features/conductor/brigadeActivity"),
      import("@/features/conductor/orchestratorControls"),
      import("@/features/chat/stores/chatStore"),
      import("@/features/chat/lib/sessionActivity"),
    ]);
    const node = useConductorGraphStore.getState().getNode(args.session_id);
    if (!node?.parentSessionId) {
      throw new CommandError(
        "invalid_args",
        `Session "${args.session_id}" was not started under another chat; flockctl only stops sessions a chat started. Ask the user to stop it in the app.`,
      );
    }
    // Same rule as starting one: a caller that names itself may only act on
    // the sessions it started.
    if (ctx.actor && ctx.actor !== node.parentSessionId) {
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
