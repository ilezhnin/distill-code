import { z } from "zod/v4";

import { FLOCKCTL_BOUNDS } from "../helpers";
import { defineCommand } from "../types";

const validateWaveSchema = z
  .object({
    plan: z
      .string()
      .min(1)
      .max(200_000)
      .describe(
        "The plan to check: the JSON object of a distill-wave block, or a whole message that carries the block (1-200000 chars).",
      ),
    conductor_session_id: z
      .string()
      .min(1)
      .max(FLOCKCTL_BOUNDS.id)
      .optional()
      .describe(
        "The conductor that would send the plan; lets a step without a model of its own be checked against that chat's model.",
      ),
  })
  .strict();

export const validateWaveCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "Check a wave plan without running it",
  description:
    "Parse a wave plan exactly as the app would when a conductor sends it, " +
    "and check each step's model, effort and fast mode against what this " +
    "installation can run now. Nothing is started and nothing is recorded. " +
    "A plan that would be refused comes back with the refusal's reason and " +
    "detail, so it can be corrected before it costs a turn; a plan that " +
    "would run comes back with its executors as the app would deal them out.",
  helpFooter: `Example:
  flockctl wave validate --plan '{"steps":[{"role":"scout","subtask":"Read the slice","access":[],"shards":["g01","g02"]}]}' --json

Result:
  {"ok": true, "executors": 2, "parallel": 8,
   "steps": [{"step": 1, "role": "...", "label": "..."|null, "access": "none"|"all", "model": "..."|null}]}
  {"ok": false, "reason": "malformed-json"|"shards-invalid"|..., "detail": "...", "step": 1|null}`,
  schema: validateWaveSchema,
  execute: async (args) => {
    const { validateWavePlan } = await import("../runtime/waves");
    return validateWavePlan(args.plan, args.conductor_session_id);
  },
});
