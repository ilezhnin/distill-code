import { z } from "zod/v4";

import { FLOCKCTL_BOUNDS, sessionTokenField } from "../helpers";
import { defineCommand } from "../types";

const cancelWaveSchema = z
  .object({
    wave_id: z
      .string()
      .min(1)
      .max(FLOCKCTL_BOUNDS.id)
      .describe(
        "Id of the wave to cancel (from `flockctl wave list`); an unambiguous prefix is accepted.",
      ),
    session_token: sessionTokenField("the chat that conducts this wave"),
  })
  .strict();

export const cancelWaveCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary:
    "Cancel a wave: stop its running executors or drop it from the queue",
  description:
    "Cancel a wave the same way the operator's stop control does: a live wave " +
    "is parked for the operator and its running executors are told to stop " +
    "(their work on disk is kept), a queued wave is dropped before it starts. " +
    "Nothing is digested or judged. The conductor chat shows a notice, and the " +
    "stopped executors' chats stay open to read. Only the chat that conducts " +
    "the wave can cancel it: from an agent's shell the call needs that chat's " +
    "--session-token.",
  helpFooter: `Example:
  flockctl wave cancel --wave-id <wave-id> --session-token <your-session-token>

Result:
  {"ok": true, "wave_id": "...", "outcome": "stopped"|"dropped"|"already_closed"}
  "stopped": the wave was live and its executors were told to stop.
  "dropped": the wave was queued and never started.
  "already_closed": the wave had already left the live loop; nothing changed.
  Refused with "wave_not_allowed" for an agent that does not conduct the wave.`,
  schema: cancelWaveSchema,
  execute: async (args, ctx) => {
    const { cancelWave, requireWaveForChange, waveCommandCaller } =
      await import("../runtime/waves");
    const wave = await requireWaveForChange(
      args.wave_id,
      "cancel",
      ctx,
      args.session_token,
    );
    return {
      ok: true,
      wave_id: wave.waveId,
      outcome: cancelWave(wave, waveCommandCaller(ctx)),
    };
  },
});
