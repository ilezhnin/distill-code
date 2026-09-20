import { z } from "zod/v4";

import { DISTILLCTL_BOUNDS } from "../helpers";
import { defineCommand } from "../types";

const createAgentSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(DISTILLCTL_BOUNDS.name)
      .describe("Name of the new agent (persona)."),
    system_prompt: z
      .string()
      .min(1)
      .max(DISTILLCTL_BOUNDS.document)
      .describe("System prompt that defines the agent's behavior."),
    model: z
      .string()
      .max(DISTILLCTL_BOUNDS.id)
      .optional()
      .describe(
        "Id of the model the agent should use (from `distillctl info models`). " +
          'An old id with the effort folded in, like "gpt-5.6-sol[xhigh]", ' +
          "is still accepted and split, but is deprecated: pass --effort instead.",
      ),
    provider: z
      .string()
      .max(DISTILLCTL_BOUNDS.id)
      .optional()
      .describe(
        "Agent harness that serves the model (from `distillctl info harnesses`, " +
          'e.g. "claude-acp", "codex-acp"). Required with --model.',
      ),
    effort: z
      .string()
      .trim()
      .min(1)
      .max(DISTILLCTL_BOUNDS.id)
      .optional()
      .describe(
        "Reasoning effort the agent's model runs at, in the harness's own words " +
          '(e.g. "high", "xhigh"). Must be one of the efforts `distillctl info ' +
          "models` lists for that model, so it requires --model. Omit it to " +
          "run at the model's default.",
      ),
    fast_mode: z
      .boolean()
      .optional()
      .describe(
        "Run the agent's model in fast mode. Only for a model `distillctl info " +
          'models` reports with "supports_fast": true, so it requires --model. ' +
          "Omit it to keep the model's default.",
      ),
  })
  .strict()
  .refine((args) => !args.model || Boolean(args.provider), {
    message: "provider is required when model is set",
    path: ["provider"],
  })
  // Effort and fast mode belong to a model: with none named the agent runs on
  // whatever the harness opens on, so there is nothing to check them against
  // and nothing for them to mean. Refused before any I/O.
  .refine(
    (args) =>
      Boolean(args.model) ||
      (args.effort === undefined && args.fast_mode === undefined),
    {
      message:
        "effort and fast_mode are checked against the model they run on; pass model (from `distillctl info models`) with them",
      path: ["model"],
    },
  );

interface CreateAgentResult {
  agent_id: string;
  deprecated?: string;
}

export const createAgentCommand = defineCommand({
  effect: "create",
  visibility: "discoverable",
  destructive: false,
  summary: "Create a new agent (persona)",
  description:
    "Create a new agent (persona); it is saved and becomes available in future chats. " +
    "Model, reasoning effort and fast mode are separate choices; an effort or fast " +
    "mode is checked against what `distillctl info models` reports for the chosen model.",
  helpFooter: `Examples:
  distillctl agent create --name "Reviewer" \\
    --system-prompt "You review diffs for correctness; be terse."
  distillctl agent create --name "Planner" --system-prompt "You plan migrations." \\
    --provider codex-acp --model gpt-5.6-sol --effort xhigh --fast-mode

Result:
  {"agent_id": "...", "deprecated": "..."?} — the agent is saved and
  becomes available in future chats; pass it as --agent-id to
  \`distillctl session create\`. Its chats start on the saved model, effort
  and fast mode. "deprecated" appears when --model folded an effort in
  and says what to pass instead.`,
  schema: createAgentSchema,
  execute: async (args): Promise<CreateAgentResult> => {
    const [
      { useAgentStore },
      { createPersona },
      { harnessModelOptions, resolveRequestedModelSelection },
      { splitLegacyFoldedModelId },
    ] = await Promise.all([
      import("@/features/agents/stores/agentStore"),
      import("@/shared/api/agents"),
      import("../runtime/providers"),
      import("@/shared/lib/foldedModelId"),
    ]);
    // The same soft check `session create` makes, through the same function.
    // The model list is only fetched when there is an effort or fast mode to
    // check (an explicit one, or one folded into the id): saving an agent with
    // just a model has never asked the harness anything, and still does not.
    const provider = args.provider;
    const needsModelList =
      Boolean(args.model && provider) &&
      (args.effort !== undefined ||
        args.fast_mode !== undefined ||
        splitLegacyFoldedModelId(args.model ?? "") != null);
    const models =
      needsModelList && provider
        ? await harnessModelOptions(provider).catch(() => [])
        : null;
    const selection = resolveRequestedModelSelection({
      harnessId: provider ?? "",
      models,
      modelId: args.model,
      effort: args.effort,
      fastMode: args.fast_mode,
      modelFlag: "--model",
    });
    const model = selection.modelId ?? args.model;
    // Deliberately no distill_agent Create Completed telemetry: distillctl creates
    // are agent/automation-driven, and the event tracks human-driven UI
    // surfaces only — matching the documented distillctl exclusion in the chat
    // send path (fireChatSendTelemetry in useChatSessionController).
    const persona = await createPersona({
      displayName: args.name,
      systemPrompt: args.system_prompt,
      provider,
      modelProviderId: model ? provider : undefined,
      model,
      ...(selection.effort !== undefined ? { effort: selection.effort } : {}),
      ...(selection.fastMode !== undefined
        ? { fastMode: selection.fastMode }
        : {}),
    });
    useAgentStore.getState().addPersona(persona);
    return {
      agent_id: persona.id,
      ...(selection.deprecated ? { deprecated: selection.deprecated } : {}),
    };
  },
});
