import { z } from "zod/v4";

import { FLOCKCTL_BOUNDS } from "../helpers";
import { defineCommand } from "../types";

const getWaveSchema = z
  .object({
    wave_id: z
      .string()
      .min(1)
      .max(FLOCKCTL_BOUNDS.id)
      .describe(
        "Id of the wave to read (from `flockctl wave list`); an unambiguous prefix is accepted.",
      ),
  })
  .strict();

export const getWaveCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "Read one wave: its steps, briefs, executors, reports and roadmap",
  description:
    "Read one wave in full — every step's brief, the session running it, its " +
    "status and stop reason, its report, and the conductor's roadmap when it " +
    "has one; does not change anything on screen.",
  helpFooter: `Example:
  flockctl wave get --wave-id <wave-id> --json

Result:
  {"wave": {... as \`flockctl wave list\`, with "subtask" filled and report
            summaries up to 4000 chars ...},
   "roadmap": null|{"conductor_session_id": "...", "goal": "...",
                    "status": "in-progress"|"paused"|"reached"|"needs-operator",
                    "note": "..."|null, "updated_at": "...", "continue_turns": 0,
                    "continue_turn_in_flight": null|{"attempt": 1, "phase": "..."},
                    "stages": [{"stage": 1, "title": "...", "status": "pending"|"active"|"done"|"blocked",
                                "evidence": ["..."]}]}}`,
  schema: getWaveSchema,
  execute: async (args) => {
    const [{ getWaveEngineState }, { requireWave, roadmapToWire, waveToWire }] =
      await Promise.all([
        import("@/features/conductor/waveStore"),
        import("../runtime/waves"),
      ]);
    const wave = requireWave(args.wave_id);
    const roadmap = getWaveEngineState().roadmaps[wave.conductorSessionId];
    return {
      wave: waveToWire(wave, "full"),
      roadmap: roadmap ? roadmapToWire(roadmap) : null,
    };
  },
});
