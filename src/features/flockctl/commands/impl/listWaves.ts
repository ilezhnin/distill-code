import { z } from "zod/v4";

import { FLOCKCTL_BOUNDS } from "../helpers";
import { defineCommand } from "../types";

const listWavesSchema = z
  .object({
    conductor_session_id: z
      .string()
      .max(FLOCKCTL_BOUNDS.id)
      .optional()
      .describe(
        "Only list the waves of this conductor chat. Omit it for every conductor's waves.",
      ),
    include_closed: z
      .boolean()
      .default(false)
      .describe(
        "Also list waves parked for the operator (stopped, blocked, undecided). Defaults to false: live and queued waves only.",
      ),
  })
  .strict();

export const listWavesCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "List the conductor's waves with their steps and executors",
  description:
    "List the waves the wave engine holds — running, waiting for a digest or a " +
    "verdict, queued behind a slot, and (with --include-closed) parked for the " +
    "operator — each with its steps, the session running each step and that " +
    "step's report status; does not change anything on screen.",
  helpFooter: `Example:
  flockctl wave list --conductor-session-id <session-id> --json

Result:
  {"waves": [{"wave_id": "...", "conductor_session_id": "...",
              "phase": "running"|"queued"|"digestPending"|"dispatchingDigest"|"awaitingVerdict"|"needsOperator",
              "live": true, "created_at": "...", "revision": 0,
              "root_request_id": "...", "queued_position": null|1,
              "closure": null|{"reason": "...", "note": "..."|null, "detail": "..."|null},
              "steps": [{"step": 1, "role": "...", "label": "..."|null,
                         "access": "none"|"all", "phase": "pending"|"spawning"|"spawned"|"failed",
                         "session_id": "..."|null, "run_id": "..."|null,
                         "status": "running"|"completed"|...|null,
                         "stop_reason": "..."|null, "failure_reason": "..."|null,
                         "dispatch_note": "..."|null, "resumed_from_session_id": "..."|null,
                         "report": null|{"status": "...", "summary": "..."}, "subtask": null}]}]}
  Newest first. "session_id" is the chat running the step; read it with
  \`flockctl session get\`. A step's "report" summary is truncated to 500
  chars here; \`flockctl wave get\` gives 4000 and the step briefs.`,
  schema: listWavesSchema,
  execute: async (args) => {
    const [{ getWaveEngineState }, { waveToWire }] = await Promise.all([
      import("@/features/conductor/waveStore"),
      import("../runtime/waves"),
    ]);
    const waves = getWaveEngineState()
      .waves.filter((wave) =>
        args.conductor_session_id
          ? wave.conductorSessionId === args.conductor_session_id
          : true,
      )
      .filter((wave) => args.include_closed || wave.phase !== "needsOperator")
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((wave) => waveToWire(wave, "summary"));
    return { waves };
  },
});
