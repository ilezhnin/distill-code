import { z } from "zod/v4";

import { FLOCKCTL_BOUNDS } from "../helpers";
import { defineCommand } from "../types";

const amendWaveStepSchema = z
  .object({
    wave_id: z
      .string()
      .min(1)
      .max(FLOCKCTL_BOUNDS.id)
      .describe("Id of the wave; an unambiguous prefix is accepted."),
    step: z
      .number()
      .int()
      .min(1)
      .max(5)
      .describe(
        "The step to extend, 1-based as `flockctl wave list` numbers them.",
      ),
    text: z
      .string()
      .min(1)
      .max(20_000)
      .describe(
        "Text appended to the step's brief, after a blank line (1-20000 chars).",
      ),
  })
  .strict();

export const amendWaveStepCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Add text to the brief of a step that has not started yet",
  description:
    "Append text to the brief of a wave step that is still pending — an " +
    "acceptor whose check should cover something the worker only just " +
    "reported, say. A step that was already dispatched is refused: its " +
    "executor has read its brief. The conductor chat shows a notice.",
  helpFooter: `Example:
  flockctl wave amend --wave-id <wave-id> --step 2 --text "Also confirm the editor lock in Temp/UnityLockfile is released."

Result:
  {"ok": true, "wave_id": "...", "step": 2}
  Refused with "wave_step_not_pending" once the step has been dispatched.`,
  schema: amendWaveStepSchema,
  execute: async (args) => {
    const { amendWaveStep, requireWave } = await import("../runtime/waves");
    const wave = requireWave(args.wave_id);
    amendWaveStep(wave, args.step, args.text);
    return { ok: true, wave_id: wave.waveId, step: args.step };
  },
});
