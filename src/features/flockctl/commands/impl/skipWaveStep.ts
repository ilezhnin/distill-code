import { z } from "zod/v4";

import { FLOCKCTL_BOUNDS, sessionTokenField } from "../helpers";
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
      .max(64)
      .describe(
        "The step to skip, 1-based as `flockctl wave list` numbers them.",
      ),
    session_token: sessionTokenField("the chat that conducts this wave"),
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
    "cancel` or its own chat instead. The conductor chat shows a notice. " +
    "Only the chat that conducts the wave can change it: from an agent's " +
    "shell the call needs that chat's --session-token.",
  helpFooter: `Example:
  flockctl wave skip --wave-id <wave-id> --step 3 --session-token <your-session-token>

Result:
  {"ok": true, "wave_id": "...", "step": 3}
  Refused with "wave_step_not_pending" once the step has been dispatched,
  and with "wave_not_allowed" for an agent that does not conduct the wave.`,
  schema: skipWaveStepSchema,
  execute: async (args, ctx) => {
    const { requireWaveForChange, skipWaveStep, waveCommandCaller } =
      await import("../runtime/waves");
    const wave = await requireWaveForChange(
      args.wave_id,
      "skip",
      ctx,
      args.session_token,
    );
    skipWaveStep(wave, args.step, waveCommandCaller(ctx));
    return { ok: true, wave_id: wave.waveId, step: args.step };
  },
});
