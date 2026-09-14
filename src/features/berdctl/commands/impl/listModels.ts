import { z } from "zod/v4";

import { BERDCTL_BOUNDS } from "../helpers";
import { defineCommand } from "../types";

const listModelsSchema = z
  .object({
    harness_id: z
      .string()
      .max(BERDCTL_BOUNDS.id)
      .optional()
      .describe(
        "Agent harness to list models for (from list_harnesses). " +
          "Omit to list models for every ready harness in one call.",
      ),
  })
  .strict();

interface ModelEntry {
  model_id: string;
  name: string;
  /** Model provider the model belongs to, when the harness reports one. */
  provider?: string;
  group: "main" | "more";
  efforts: string[] | null;
  default_effort: string | null;
  supports_fast: boolean | null;
}

interface ListModelsResult {
  harnesses: Array<{
    harness_id: string;
    models: ModelEntry[];
    /** Present when a stale cached list was served (the last refresh failed)
     *  or when the harness manages its model outside the app. */
    warning?: string;
  }>;
}

export const listModelsCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "List the models available per agent harness",
  description:
    "List the models available per agent harness (same source as the app's " +
    "model picker), with the reasoning efforts and fast mode each model " +
    "offers; omit harness_id to cover every ready harness in one call. Use a " +
    "model_id (and its harness_id) when creating a session.",
  helpFooter: `Example:
  berdctl info models --harness-id codex-acp --json

Result:
  {"harnesses": [{"harness_id": "...",
                  "models": [{"model_id": "...", "name": "...",
                              "provider": "..."?,
                              "group": "main"|"more",
                              "efforts": ["low", "high", ...]|null,
                              "default_effort": "..."|null,
                              "supports_fast": true|false|null}],
                  "warning": "..."?}]}
  Model, effort and fast mode are separate choices: a model_id never carries
  an effort. Pass a model_id (with its harness) as --model-id when creating a
  session, pick --effort from that model's "efforts", and pass --fast-mode
  only where "supports_fast" is true. "efforts": [] means the model has no
  effort control; null in "efforts" or "supports_fast" means the app has not
  learned what the model offers. "group" is the picker page the model is
  filed under ("more" is the More models page). "warning" appears when a
  stale cached list was served or when the harness manages its model outside
  the app.`,
  schema: listModelsSchema,
  execute: async (args): Promise<ListModelsResult> => {
    const [
      { getProviderModelSelectionHint },
      { useProviderModelCacheStore },
      { findReadyHarnessOrThrow, listHarnessStatuses, harnessModelOptions },
    ] = await Promise.all([
      import("@/features/providers/modelSelectionHints"),
      import("@/features/providers/stores/providerModelCacheStore"),
      import("../runtime/providers"),
    ]);
    const targets = args.harness_id
      ? [await findReadyHarnessOrThrow(args.harness_id)]
      : (await listHarnessStatuses()).filter(
          (harness) => harness.readiness === "ready",
        );
    const harnesses = await Promise.all(
      targets.map(async (harness) => {
        const models = await harnessModelOptions(harness.id);
        const hint = getProviderModelSelectionHint(harness.id);
        // A failed refresh keeps serving the previous cache; tell the
        // caller the list may be stale instead of silently masking it.
        const staleError = useProviderModelCacheStore
          .getState()
          .getError(harness.id);
        const warning =
          hint ?? (staleError ? `list may be stale: ${staleError}` : null);
        return {
          harness_id: harness.id,
          models,
          ...(warning ? { warning } : {}),
        };
      }),
    );
    return { harnesses };
  },
});
