import { z } from "zod/v4";

import { FLOCKCTL_BOUNDS, sessionTokenField } from "../helpers";
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
    session_token: sessionTokenField("the chat that conducts this wave"),
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
    "and for a wave that is no longer running its steps. Only the chat that " +
    "conducts the wave can change it: from an agent's shell the call needs " +
    "that chat's --session-token, and without it no session is stopped or " +
    "started.",
  helpFooter: `Example:
  flockctl wave restart --wave-id <wave-id> --step 2 --session-token <your-session-token> \\
    --text "Use the 2020 register, not the 1998 one."

Result:
  {"ok": true, "wave_id": "...", "step": 2, "stopped_session_id": "..."|null}
  Refused with "wave_step_not_dispatched" for a pending step (use \`wave amend\`),
  with "wave_not_running" once the wave has gone to its digest, and with
  "wave_not_allowed" for an agent that does not conduct the wave.`,
  schema: restartWaveStepSchema,
  execute: async (args, ctx) => {
    const { requireWaveForChange, restartWaveStep, waveCommandCaller } =
      await import("../runtime/waves");
    const wave = await requireWaveForChange(
      args.wave_id,
      "restart",
      ctx,
      args.session_token,
    );
    const stopped = await restartWaveStep(
      wave,
      args.step,
      args.text,
      waveCommandCaller(ctx),
    );
    return {
      ok: true,
      wave_id: wave.waveId,
      step: args.step,
      stopped_session_id: stopped,
    };
  },
});
