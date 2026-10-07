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
import type { SessionRunSettings } from "@/features/chat/lib/sessionRunSettings";
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
  type ModelPreferenceClassId,
  type RankableModel,
  type RankedModelResolution,
  type RankedModelResolutionInput,
} from "./modelRanking";

export interface RankedPersonaTargetContext {
  /** Available harnesses (agent providers) by id. */
  providers: readonly { id: string }[];
  /**
   * Models the harness is CONFIRMED to serve right now.
   *
   * Every id this returns can end up pinned on a session, so callers must not
   * pass the picker's list. The model cache keeps a provider's last payload
   * when a discovery refresh answers nothing (a retryable non-answer, not an
   * empty inventory), and a ranking that matches against that leftover pins
   * the chat to a model the harness has dropped — the host forwards the id
   * verbatim and every send fails with "Failed to set ACP model option:
   * Invalid params", out of `stream()`, where the chat cannot rescue itself.
   * Filter by `isCachedModelInventoryAuthoritative` (or use the hook's
   * `getInstalledModelsForAgent`) first; an unconfirmed harness must report an
   * empty list, which reads here as "not installed" and lets the session start
   * on the harness' own current model instead.
   */
  getModelsForHarness: (harnessId: string) => readonly RankableModel[];
  rateLimits: readonly ProviderRateLimits[];
  /**
   * The operator's own order per class (P36). Applies only where the ranking
   * comes from a class; an agent's own list is already the operator's.
   */
  classOverrides?: Partial<Record<ModelPreferenceClassId, string[]>>;
  /**
   * Window fullness at which a platform should be passed over (P37/P38).
   *
   * Omitted keeps the shipped default. Waves pass a stricter number than
   * chats do, because a wave runs unattended and spawns several sessions at
   * once against the same meter.
   */
  nearLimitPercent?: number;
  /**
   * Ranking to use instead of the persona's own (P36).
   *
   * A wave step may name its complexity class, which is a statement about the
   * work rather than about the agent: the same `brigade` role can be a
   * one-line rename or a week of refactoring, and the operator asked to route
   * those differently without maintaining two agents.
   */
  classId?: ModelPreferenceClassId;
}

export interface RankedPersonaTarget {
  target: SessionExecutionTarget;
  /**
   * The effort and fast mode the winning candidate asks for, as the session's
   * run-settings intent. A sibling of `target`, never part of it (see
   * `sessionRunSettings.ts`), and applied the same way on every harness.
   *
   * Kept even when the model does not advertise the effort
   * (`resolution.choice.effortApplied === false`): the intent survives, and
   * the run-settings reconciler shows what runs instead.
   */
  runSettings: SessionRunSettings;
  resolution: RankedModelResolution;
}

export function rankedPersonaExecutionTarget(
  persona: Pick<Persona, "displayName" | "modelRanking">,
  context: RankedPersonaTargetContext,
): RankedPersonaTarget | undefined {
  return rankedPersonaExecutionTargets(persona, context)[0];
}

/** Feasible preferences in dispatch order, with limits resolved by the same policy. */
export function rankedPersonaExecutionTargets(
  persona: Pick<Persona, "displayName" | "modelRanking">,
  context: RankedPersonaTargetContext,
): RankedPersonaTarget[] {
  // The agent's own list wins; the bundled-slug class is the fallback, so an
  // agent nobody has tuned still runs on the ranking its role deserves.
  // A class named by the caller wins over both: it is a statement about the
  // work in hand, which the agent's standing preference cannot know about.
  const source = context.classId
    ? ({ kind: "class", classId: context.classId } as const)
    : (parseAgentRankingSource(persona.modelRanking) ??
      (() => {
        const classId = modelPreferenceClassForPersona(persona);
        return classId ? ({ kind: "class", classId } as const) : undefined;
      })());
  if (!source) return [];

  const installed = new Set(context.providers.map((provider) => provider.id));
  const remaining = candidatesForRankingSource(
    source,
    context.classOverrides,
  ).map((candidate, rankIndex) => ({ candidate, rankIndex }));
  const input: RankedModelResolutionInput = {
    modelsForPlatform: (platform) =>
      installed.has(platform) ? context.getModelsForHarness(platform) : [],
    allModels: () =>
      context.providers.flatMap((provider) =>
        context
          .getModelsForHarness(provider.id)
          .map((model) => ({ harnessId: provider.id, model })),
      ),
    platformLimitState: (platform, scopedWindow) =>
      platformLimitState(context.rateLimits, platform, {
        scopedWindow,
        ...(typeof context.nearLimitPercent === "number"
          ? { nearLimitPercent: context.nearLimitPercent }
          : {}),
      }),
  };
  const targets: RankedPersonaTarget[] = [];
  const seen = new Set<string>();
  while (remaining.length > 0) {
    const resolution = resolveRankedCandidates(
      remaining.map((row) => row.candidate),
      input,
    );
    if (!resolution.choice) break;
    const localIndex = resolution.choice.rankIndex;
    const originalIndex = remaining[localIndex].rankIndex;
    remaining.splice(localIndex, 1);
    resolution.choice = { ...resolution.choice, rankIndex: originalIndex };
    const { harnessId, model, effort, fast } = resolution.choice;
    const key = JSON.stringify([
      harnessId,
      model.providerId,
      model.id,
      effort ?? null,
      fast ?? false,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      targets.push({
        runSettings: {
          ...(effort ? { effort } : {}),
          ...(fast !== undefined ? { fast } : {}),
        },
        // A concrete model needs the provider that serves it; without this the
        // normalizer refused every resolution the ranking made, so the feature
        // could not retarget anything at all. The model's own provider id is
        // the right one — for a harness that fans several providers into one
        // list, the harness id is not a provider.
        target: normalizeSessionExecutionTarget({
          harnessId,
          modelProviderId: model.providerId ?? harnessId,
          modelId: model.id,
          modelName: model.displayName ?? model.name ?? model.id,
        }),
        resolution,
      });
    } catch {
      // Malformed inventory rows are not dispatch candidates.
    }
  }
  return targets;
}
