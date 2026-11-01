import { z } from "zod/v4";

import { FLOCKCTL_BOUNDS } from "../helpers";
import { defineCommand } from "../types";

const getRoadmapSchema = z
  .object({
    conductor_session_id: z
      .string()
      .min(1)
      .max(FLOCKCTL_BOUNDS.id)
      .describe("Id of the conductor chat whose roadmap to read."),
  })
  .strict();

export const getRoadmapCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "Read a conductor's roadmap: its goal, stages and loop state",
  description:
    "Read the roadmap a conductor published with a distill-roadmap block — " +
    "the goal it pursues on its own, its stages and their status, and where " +
    "the autonomous continue loop stands; does not change anything on screen.",
  helpFooter: `Example:
  flockctl wave roadmap --conductor-session-id <session-id> --json

Result:
  {"roadmap": null|{"conductor_session_id": "...", "goal": "...",
                    "status": "in-progress"|"paused"|"reached"|"needs-operator",
                    "note": "..."|null, "updated_at": "...", "continue_turns": 0,
                    "continue_turn_in_flight": null|{"attempt": 1, "phase": "pending"|"dispatching"|"awaiting"},
                    "stages": [{"stage": 1, "title": "...", "status": "...", "evidence": ["..."]}]}}
  null means the conductor has not published a roadmap. The conductor
  changes it by publishing a new block; there is no command that edits it.`,
  schema: getRoadmapSchema,
  execute: async (args) => {
    const [{ getWaveEngineState }, { roadmapToWire }] = await Promise.all([
      import("@/features/conductor/waveStore"),
      import("../runtime/waves"),
    ]);
    const roadmap = getWaveEngineState().roadmaps[args.conductor_session_id];
    return { roadmap: roadmap ? roadmapToWire(roadmap) : null };
  },
});
