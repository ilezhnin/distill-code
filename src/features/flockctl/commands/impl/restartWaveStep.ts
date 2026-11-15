import { z } from "zod/v4";

import { FLOCKCTL_BOUNDS } from "../helpers";
import { defineCommand } from "../types";

const restartWaveStepSchema = z
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
        "The step to run again, 1-based as `flockctl wave list` numbers them.",
      ),
    text: z
      .string()
      .min(1)
      .max(20_000)
      .optional()
      .describe(
        "Optional correction appended to the step's brief, after a blank line (1-20000 chars).",
      ),
  })
  .strict();

export const restartWaveStepCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Stop a dispatched step and run it again in a new session",
  description:
    "Run one step of a running wave again: its executor is stopped if it is " +
    "still working, and the step is dispatched afresh in a new session with " +
    "its brief, plus the correction when one is given. For a step that went " +
    "wrong, went quiet, or was given the wrong task — `wave amend` only " +
    "reaches a step that has not started, and `wave steer` waits for a turn " +
    "to end on providers that take no message mid-turn. The stopped session " +
    "stays in the sidebar; files it wrote stay as they are. The conductor " +
    "chat shows a notice. Refused for a step that has not been dispatched " +
    "and for a wave that is no longer running its steps.",
  helpFooter: `Example:
  flockctl wave restart --wave-id <wave-id> --step 2 --text "Use the 2020 register, not the 1998 one."

Result:
  {"ok": true, "wave_id": "...", "step": 2, "stopped_session_id": "..."|null}
  Refused with "wave_step_not_dispatched" for a pending step (use \`wave amend\`)
  and with "wave_not_running" once the wave has gone to its digest.`,
  schema: restartWaveStepSchema,
  execute: async (args) => {
    const { requireWave, restartWaveStep } = await import("../runtime/waves");
    const wave = requireWave(args.wave_id);
    const stopped = await restartWaveStep(wave, args.step, args.text);
    return {
      ok: true,
      wave_id: wave.waveId,
      step: args.step,
      stopped_session_id: stopped,
    };
  },
});
