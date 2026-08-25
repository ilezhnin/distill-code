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
import { platformLimitState } from "@/features/status/lib/rateLimitWindows";
import type { ProviderRateLimits } from "@/features/status/lib/rateLimitTypes";
import type { Persona } from "@/shared/types/agents";

import {
  candidatesForRankingSource,
  parseAgentRankingSource,
} from "./agentModelRanking";
import {
  modelPreferenceClassForPersona,
  resolveRankedCandidates,
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
  // The agent's own list wins; the bundled-slug class is the fallback, so an
  // agent nobody has tuned still runs on the ranking its role deserves.
  const source =
    parseAgentRankingSource(persona.modelRanking) ??
    (() => {
      const classId = modelPreferenceClassForPersona(persona);
      return classId ? ({ kind: "class", classId } as const) : undefined;
    })();
  if (!source) return undefined;

  const installed = new Set(context.providers.map((provider) => provider.id));
  const resolution = resolveRankedCandidates(
    candidatesForRankingSource(source),
    {
      modelsForPlatform: (platform) =>
        installed.has(platform) ? context.getModelsForHarness(platform) : [],
      allModels: () =>
        context.providers.flatMap((provider) =>
          context
            .getModelsForHarness(provider.id)
            .map((model) => ({ harnessId: provider.id, model })),
        ),
      platformLimitState: (platform, scopedWindow) =>
        platformLimitState(context.rateLimits, platform, { scopedWindow }),
    },
  );
  if (!resolution.choice) return undefined;

  const { harnessId, model } = resolution.choice;
  try {
    return {
      // A concrete model needs the provider that serves it; without this the
      // normalizer refused every resolution the ranking made, so the feature
      // could not retarget anything at all. The model's own provider id is
      // the right one — for a harness that fans several providers into one
      // list (goose), the harness id is not a provider.
      target: normalizeSessionExecutionTarget({
        harnessId,
        modelProviderId: model.providerId ?? harnessId,
        modelId: model.id,
        modelName: model.displayName ?? model.name ?? model.id,
      }),
      resolution,
    };
  } catch {
    // A preference must never stop a session from starting: fall back to the
    // persona's single model exactly as an unresolvable ranking does.
    return undefined;
  }
}
