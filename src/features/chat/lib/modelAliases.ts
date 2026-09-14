import type { ModelOption } from "../types";

/**
 * Ids a harness lists for "whatever the CLI resolves this to right now"
 * rather than for one model: Claude Code's "default", and "current".
 */
const MODEL_ALIAS_IDS = new Set(["current", "default"]);

export function isModelAlias(modelId?: string | null): boolean {
  return modelId != null && MODEL_ALIAS_IDS.has(modelId);
}

function rowLabel(model: ModelOption): string {
  return (model.displayName ?? model.name).trim().toLowerCase();
}

/** The model a row is another name for, when the harness says so. */
function aliasTarget(model: ModelOption): string | undefined {
  const target = model.aliasOf?.trim();
  return target ? target : undefined;
}

function isAliasRow(model: ModelOption): boolean {
  return aliasTarget(model) != null || isModelAlias(model.id);
}

/**
 * Drops one of two rows when a harness lists an alias next to the model that
 * alias resolves to.
 *
 * Claude Code lists both "default" and "opus[1m]", and both read "Opus 5", so
 * the list would name that model twice. The selected row always survives:
 * while the session runs on the alias that row stays and its twin goes,
 * otherwise the alias goes. Only the rows shown change — the inventory keeps
 * both ids, since sessions and agent rankings may be pinned to either.
 *
 * The pairing is the harness's own `aliasOf` where it states one. Comparing
 * labels is what this did before anything said it, and it stays as the
 * fallback for a harness that supplies none — a rule read off two display
 * strings, which is why the explicit answer is preferred.
 */
export function hideAliasTwins(
  models: ModelOption[],
  selectedModelId: string | null | undefined,
): ModelOption[] {
  const listedIds = new Set(models.map((model) => model.id));
  const concreteLabels = new Set(
    models.filter((model) => !isAliasRow(model)).map(rowLabel),
  );
  const selectedAliasTargets = new Set<string>();
  const selectedAliasLabels = new Set<string>();
  for (const model of models) {
    if (model.id !== selectedModelId || !isAliasRow(model)) {
      continue;
    }
    const target = aliasTarget(model);
    if (target) {
      selectedAliasTargets.add(target);
    } else {
      selectedAliasLabels.add(rowLabel(model));
    }
  }
  return models.filter((model) => {
    if (isAliasRow(model)) {
      if (model.id === selectedModelId) {
        return true;
      }
      const target = aliasTarget(model);
      return target
        ? !listedIds.has(target)
        : !concreteLabels.has(rowLabel(model));
    }
    return (
      !selectedAliasTargets.has(model.id) &&
      !selectedAliasLabels.has(rowLabel(model))
    );
  });
}
