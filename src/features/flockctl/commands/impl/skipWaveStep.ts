import { z } from "zod/v4";

import { FLOCKCTL_BOUNDS } from "../helpers";
import { defineCommand } from "../types";

const skipWaveStepSchema = z
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
        "The step to skip, 1-based as `flockctl wave list` numbers them.",
      ),
  })
  .strict();

export const skipWaveStepCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Skip a step that has not started yet",
  description:
    "Mark a pending wave step as not done without starting it, so the steps " +
    "that wait on it proceed and the digest shows it as skipped. A step " +
    "already dispatched is refused: stop its executor with `flockctl wave " +
    "cancel` or its own chat instead. The conductor chat shows a notice.",
  helpFooter: `Example:
  flockctl wave skip --wave-id <wave-id> --step 3

Result:
  {"ok": true, "wave_id": "...", "step": 3}
  Refused with "wave_step_not_pending" once the step has been dispatched.`,
  schema: skipWaveStepSchema,
  execute: async (args) => {
    const { requireWave, skipWaveStep } = await import("../runtime/waves");
    const wave = requireWave(args.wave_id);
    skipWaveStep(wave, args.step);
    return { ok: true, wave_id: wave.waveId, step: args.step };
  },
});
