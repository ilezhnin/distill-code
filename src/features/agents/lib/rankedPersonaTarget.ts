/**
 * Resolves a persona's ranked model preference into a concrete execution
 * target against the live provider inventory and the rate-limit meters.
 *
 * This sits beside `personaExecutionTarget` rather than inside it: the single
 * `model` field stays the compatibility path, and a ranking — the persona's
 * own `modelRanking` property or the bundled-slug default — takes precedence
 * when it resolves. When nothing in the ranking is usable the caller falls
 * back to the single-model path, so a ranking can never stop a session from
 * starting.
 *
 * D5 visibility contract: the resolution reports the rank that won and every
 * higher-ranked candidate that was skipped; the caller must surface a rank>0
 * pick to the operator. Nothing here toasts on its own — pure function.
 */

import {
  normalizeSessionExecutionTarget,
  type SessionExecutionTarget,
} from "@/features/chat/lib/sessionExecutionTarget";
import { isPlatformAtLimit } from "@/features/status/lib/rateLimitWindows";
import type { ProviderRateLimits } from "@/features/status/lib/rateLimitTypes";
import type { Persona } from "@/shared/types/agents";

import {
  modelPreferenceClassForPersona,
  resolveRankedModel,
  type RankableModel,
  type RankedModelResolution,
} from "./modelRanking";

export interface RankedPersonaTargetContext {
  /** Available harnesses (agent providers) by id. */
  providers: readonly { id: string }[];
  getModelsForHarness: (harnessId: string) => readonly RankableModel[];
  rateLimits: readonly ProviderRateLimits[];
}

export interface RankedPersonaTarget {
  target: SessionExecutionTarget;
  resolution: RankedModelResolution;
}

export function rankedPersonaExecutionTarget(
  persona: Pick<Persona, "displayName" | "modelRanking">,
  context: RankedPersonaTargetContext,
): RankedPersonaTarget | undefined {
  const classId = modelPreferenceClassForPersona(persona);
  if (!classId) return undefined;

  const installed = new Set(context.providers.map((provider) => provider.id));
  const resolution = resolveRankedModel(classId, {
    modelsForPlatform: (platform) =>
      installed.has(platform) ? context.getModelsForHarness(platform) : [],
    allModels: () =>
      context.providers.flatMap((provider) =>
        context
          .getModelsForHarness(provider.id)
          .map((model) => ({ harnessId: provider.id, model })),
      ),
    isPlatformAtLimit: (platform) =>
      isPlatformAtLimit(context.rateLimits, platform),
  });
  if (!resolution.choice) return undefined;

  const { harnessId, model } = resolution.choice;
  return {
    target: normalizeSessionExecutionTarget({
      harnessId,
      modelId: model.id,
      modelName: model.displayName ?? model.name ?? model.id,
    }),
    resolution,
  };
}
