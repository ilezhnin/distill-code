import { z } from "zod/v4";

import { FLOCKCTL_BOUNDS } from "../helpers";
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
    "stopped executors' chats stay open to read.",
  helpFooter: `Example:
  flockctl wave cancel --wave-id <wave-id>

Result:
  {"ok": true, "wave_id": "...", "outcome": "stopped"|"dropped"|"already_closed"}
  "stopped": the wave was live and its executors were told to stop.
  "dropped": the wave was queued and never started.
  "already_closed": the wave had already left the live loop; nothing changed.`,
  schema: cancelWaveSchema,
  execute: async (args) => {
    const { cancelWave, requireWave } = await import("../runtime/waves");
    const wave = requireWave(args.wave_id);
    return { ok: true, wave_id: wave.waveId, outcome: cancelWave(wave) };
  },
});
