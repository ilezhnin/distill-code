import {
  isAgentRankingPlatform,
  scopedWindowForModel,
} from "@/features/agents/lib/agentModelRanking";
import type { RankedPersonaTargetContext } from "@/features/agents/lib/rankedPersonaTarget";
import { normalizeSessionExecutionTarget } from "@/features/chat/lib/sessionExecutionTarget";
import { platformLimitState } from "@/features/status/lib/rateLimitWindows";
import type { SessionExecutionTarget } from "@/features/chat/lib/sessionExecutionTarget";
import type { SessionRunSettings } from "@/features/chat/lib/sessionRunSettings";
import type { RankableModel } from "@/features/agents/lib/modelRanking";
import type { Configuration } from "../types";
import type { PublicSelectorTask } from "./benchmarkLearning";

export interface ApplicationExecutorOption {
  target: SessionExecutionTarget;
  runSettings?: SessionRunSettings;
}

/** Inventory is the candidate pool; saved rankings only order the fallback.
 * The caller supplies authoritative inventory. Account access is rechecked by
 * the native host; this pool does not grant execution or learned permission.
 */
export function automaticExecutorOptions(
  context: RankedPersonaTargetContext,
  preferred: readonly ApplicationExecutorOption[],
): ApplicationExecutorOption[] {
  const inventory: ApplicationExecutorOption[] = [];
  for (const provider of context.providers) {
    if (!isAgentRankingPlatform(provider.id)) continue;
    for (const model of context.getModelsForHarness(provider.id)) {
      const label = model.displayName ?? model.name ?? model.id;
      if (
        platformLimitState(context.rateLimits, provider.id, {
          nearLimitPercent: context.nearLimitPercent,
          scopedWindow: scopedWindowForModel(provider.id, model.id, label),
        }) === "at-limit"
      )
        continue;
      try {
        inventory.push({
          target: normalizeSessionExecutionTarget({
            harnessId: provider.id,
            modelProviderId: model.providerId ?? provider.id,
            modelId: model.id,
            modelName: label,
          }),
        });
      } catch {
        // An invalid advertised row is not an executable target.
      }
    }
  }
  const eligible = new Set(
    inventory.map(({ target }) =>
      JSON.stringify([
        target.harnessId,
        target.modelProviderId,
        target.modelId,
      ]),
    ),
  );
  const feasiblePreferences = preferred.filter(({ target }) =>
    eligible.has(
      JSON.stringify([
        target.harnessId,
        target.modelProviderId,
        target.modelId,
      ]),
    ),
  );
  return applicationExecutorEffortOptions(
    [...feasiblePreferences, ...inventory],
    (target) =>
      context
        .getModelsForHarness(target.harnessId)
        .find(
          (model) =>
            model.id === target.modelId &&
            (model.providerId ?? target.harnessId) === target.modelProviderId,
        ),
  );
}

/** Add advertised effort/speed choices after the original fallback options. */
export function applicationExecutorEffortOptions(
  preferred: readonly ApplicationExecutorOption[],
  modelForTarget: (target: SessionExecutionTarget) => RankableModel | undefined,
): ApplicationExecutorOption[] {
  const options: ApplicationExecutorOption[] = [];
  const seen = new Set<string>();
  const add = (option: ApplicationExecutorOption) => {
    const id = applicationExecutorConfiguration(option)?.id;
    if (!id || seen.has(id)) return;
    seen.add(id);
    options.push(option);
  };
  preferred.forEach(add);
  for (const option of preferred) {
    const model = modelForTarget(option.target);
    if (
      !model ||
      model.id !== option.target.modelId ||
      (model.providerId ?? option.target.harnessId) !==
        option.target.modelProviderId
    )
      continue;
    const addAdvertisedSpeedModes = (choice: ApplicationExecutorOption) => {
      if (
        choice.runSettings?.fast === undefined &&
        typeof model.supportsFast === "boolean"
      ) {
        add({
          target: choice.target,
          runSettings: { ...choice.runSettings, fast: false },
        });
        if (model.supportsFast)
          add({
            target: choice.target,
            runSettings: { ...choice.runSettings, fast: true },
          });
      }
    };
    if (
      !option.runSettings?.effort ||
      model.efforts?.some((effort) => effort.id === option.runSettings?.effort)
    )
      addAdvertisedSpeedModes(option);
    for (const effort of model.efforts ?? []) {
      if (!effort.id.trim()) continue;
      const choice = {
        target: option.target,
        runSettings: { ...option.runSettings, effort: effort.id },
      };
      add(choice);
      addAdvertisedSpeedModes(choice);
    }
  }
  return options;
}

/** Preserve saved fallback order, then use an available inventory default if none survives. */
export function applicationExecutorPriorIds(
  candidates: readonly { configuration: Configuration; available: boolean }[],
  preferredIds: Iterable<string | undefined>,
): string[] {
  const availableIds = new Set(
    candidates
      .filter((row) => row.available)
      .map((row) => row.configuration.id),
  );
  const preferred = [...new Set(preferredIds)].filter((id): id is string =>
    Boolean(id && availableIds.has(id)),
  );
  return preferred.length ? preferred : [...availableIds].slice(0, 1);
}

/** Local inventory row identity; the native service owns evidence-key hashing. */
export function applicationExecutorConfiguration(
  option: ApplicationExecutorOption,
): Configuration | null {
  const { target, runSettings } = option;
  if (!target.modelId) return null;
  return {
    id: JSON.stringify([
      target.harnessId,
      target.modelProviderId,
      target.modelId,
      runSettings?.effort ?? null,
      runSettings?.fast ?? null,
    ]),
    providerId: target.harnessId,
    accountId: null,
    modelId: target.modelId,
    modelName: target.modelName ?? null,
    effort: runSettings?.effort ?? null,
    fastMode: runSettings?.fast ?? null,
    billingMode: "unknown",
    executionProfile: "interactive_acp",
    inventoryRevision: null,
  };
}

/** Unknown runtime limits are zero; this does not assert benchmark isolation. */
export function applicationExecutorTask(input: {
  prompt: string;
  workClassId: string;
  roleId: string | null;
  rolePrompt: string;
  timeoutSeconds?: number;
}): PublicSelectorTask {
  return {
    prompt: input.prompt,
    workClassId: input.workClassId,
    roleId: input.roleId,
    rolePrompt: input.rolePrompt,
    fixtures: [],
    facets: {},
    permissions: {
      tools: ["acp_session"],
      network: true,
      context:
        "Interactive session permissions are resolved by the agent host at dispatch.",
    },
    executionProfile: "interactive_acp",
    limits: {
      timeoutSeconds: Math.ceil(input.timeoutSeconds ?? 0),
      maxTurns: 0,
      maxArtifactBytes: 0,
    },
    entry: null,
  };
}
