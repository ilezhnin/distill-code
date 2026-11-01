import { z } from "zod/v4";

import { FLOCKCTL_BOUNDS } from "../helpers";
import { defineCommand } from "../types";

const steerWaveSchema = z
  .object({
    wave_id: z
      .string()
      .min(1)
      .max(FLOCKCTL_BOUNDS.id)
      .describe(
        "Id of the wave whose running executors receive the message; an unambiguous prefix is accepted.",
      ),
    prompt: z
      .string()
      .min(1)
      .max(50_000)
      .describe(
        "The message every running executor of the wave receives (1-50000 chars).",
      ),
    from: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[^\r\n]*$/, "Sender label must be a single line.")
      .optional()
      .describe("Optional visible sender label for the message (1-120 chars)."),
  })
  .strict();

export const steerWaveCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Send one message to every running executor of a wave",
  description:
    "Send the same message into the chat of every executor of the wave that " +
    "is still running — steered into its current turn when it is working, " +
    "queued when it is between turns. Executors that already finished are " +
    "left alone. Each message is visible in that executor's chat.",
  helpFooter: `Example:
  flockctl wave steer --wave-id <wave-id> --prompt "Pause: the operator is about to restart Unity. Save your state to STATUS.md and wait." --json

Result:
  {"wave_id": "...", "deliveries": [{"session_id": "...",
      "send_status": "dispatched"|"steered"|"queued"|"deduplicated"|"delivery_unconfirmed"|"not_delivered"}]}
  An empty "deliveries" list means no executor of the wave is running.`,
  schema: steerWaveSchema,
  execute: async (args, ctx) => {
    const [{ requireWave, runningWaveSessionIds }, { sendSessionCommand }] =
      await Promise.all([import("../runtime/waves"), import("./sendSession")]);
    const wave = requireWave(args.wave_id);
    const deliveries: Array<{ session_id: string; send_status: string }> = [];
    for (const sessionId of runningWaveSessionIds(wave)) {
      const result = await sendSessionCommand.execute(
        {
          session_id: sessionId,
          prompt: args.prompt,
          if_running: "steer",
          ...(args.from ? { from: args.from } : {}),
        },
        ctx,
      );
      deliveries.push({
        session_id: sessionId,
        send_status: result.send_status,
      });
    }
    return { wave_id: wave.waveId, deliveries };
  },
});
