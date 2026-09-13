/**
 * The execution target a wave step should run on.
 *
 * Until now every wave child inherited the conductor's model, so a ranking the
 * operator wrote for `writer` or `acceptor` had no effect on the workers that
 * actually do the work — the one place the preference matters most, because a
 * wave spends several sessions at once against the same rate limits.
 *
 * This is the effectful seam: it reads the persona for the step's role and the
 * live provider inventory and rate limits, and hands back a target. Everything
 * it decides is pure and already tested in `modelRanking` / `agentModelRanking`
 * — here we only gather the inputs and stay out of the way when there is
 * nothing to say, in which case the child inherits the conductor exactly as
 * before.
 */

import {
  candidatesForRankingSource,
  parseAgentRankingSource,
  scopedWindowForModel,
} from "@/features/agents/lib/agentModelRanking";
import {
  modelPreferenceClassForPersona,
  rankIndexOfModel,
  type ModelPreferenceClassId,
  type RankableModel,
} from "@/features/agents/lib/modelRanking";
import { rankedPersonaExecutionTarget } from "@/features/agents/lib/rankedPersonaTarget";
import type { RoutingPolicy } from "@/features/agents/lib/routingPolicy";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { getRoutingPolicy } from "@/features/agents/stores/routingPolicyStore";
import {
  normalizeSessionExecutionTarget,
  type SessionExecutionTarget,
} from "@/features/chat/lib/sessionExecutionTarget";
import {
  splitEmbeddedReasoning,
  type EmbeddedReasoningEffort,
} from "@/features/chat/lib/modelReasoningVariants";
import type { ModelOption } from "@/features/chat/types";
import {
  isCachedModelInventoryAuthoritativeForRouting,
  useProviderModelCacheStore,
} from "@/features/providers/stores/providerModelCacheStore";
import type { AgentPlatformId } from "@/features/status/lib/rateLimitTypes";
import {
  platformLimitState,
  type PlatformLimitState,
} from "@/features/status/lib/rateLimitWindows";
import { useProviderRateLimitsStore } from "@/features/status/stores/providerRateLimitsStore";

import { resolvePersonaForRole } from "./roleCatalog";
import type { WaveStepModelCheck } from "./waveEngine";

export interface WaveStepTarget {
  target: SessionExecutionTarget;
  /** Operator-facing name of the picked candidate ("Opus 5"). */
  label: string;
  /** True when the pick was a fallback down the ranking. */
  fallback: boolean;
  /** True when nothing was clear of its limit and this one was taken anyway. */
  nearLimit: boolean;
  /**
   * Reasoning effort the ranking asked for, when it named one (P36).
   *
   * The ranking's profiles differ by effort as much as by model — "medium
   * engineering at medium, heavy at xhigh" is the whole difference between two
   * of them — and only harnesses that serve each tier as its own model id get
   * that from `modelId` alone. For every other harness the effort has to be
   * composed onto the child session after it is created, which is what the
   * spawn does with this; without it `coding-simple` and `coding-complex`
   * routed identically on claude-acp and grok-acp.
   */
  effort?: EmbeddedReasoningEffort;
}

/** Test seam: everything about the world this resolution reads. */
export interface WaveStepTargetIo {
  routingPolicy: () => RoutingPolicy;
  personas: () => ReturnType<typeof useAgentStore.getState>["personas"];
  providers: () => ReturnType<typeof useAgentStore.getState>["providers"];
  modelsForHarness: (harnessId: string) => readonly ModelOption[];
  rateLimits: () => ReturnType<
    typeof useProviderRateLimitsStore.getState
  >["snapshot"] extends infer Snapshot
    ? Snapshot extends { providers: infer Providers }
      ? Providers
      : never
    : never;
}

const liveIo: WaveStepTargetIo = {
  routingPolicy: () => getRoutingPolicy(),
  personas: () => useAgentStore.getState().personas,
  providers: () => useAgentStore.getState().providers,
  modelsForHarness: (harnessId) => {
    // Only an inventory the cache itself calls authoritative may name the
    // model a wave child is spawned on. An empty discovery refresh no longer
    // clears the cache — it keeps the previous payload as a retryable
    // non-answer — so the raw entry can still list models the harness has
    // stopped serving, and a step spawned on one of those ids dies on every
    // send with "Failed to set ACP model option: Invalid params". Reporting
    // nothing instead makes the step inherit the conductor, which runs.
    //
    // The routing test is the stricter one: a poll that *failed* (a bridge
    // that is not installed, crashed on start, or lost its auth) keeps the
    // previous list with its `fetchedAt`, and the crew profiles put that same
    // harness first for most worker roles — so every step of the wave resolved
    // onto a bridge the app already knew was failing and each one died with no
    // retry (Q2). An unusable harness reports nothing here, which the ranking
    // reads as "not installed" and skips.
    const entry = useProviderModelCacheStore
      .getState()
      .providers.get(harnessId);
    return isCachedModelInventoryAuthoritativeForRouting(entry)
      ? (entry?.models ?? [])
      : [];
  },
  rateLimits: () =>
    useProviderRateLimitsStore.getState().snapshot?.providers ?? [],
};

let io: WaveStepTargetIo = liveIo;

export function setWaveStepTargetIoForTests(next: Partial<WaveStepTargetIo>) {
  io = { ...liveIo, ...next };
}

export function resetWaveStepTargetIoForTests() {
  io = liveIo;
}

/**
 * True when the harness is currently advertising this target's model id.
 *
 * A target with no concrete model is not a claim about any model, so it
 * passes: those inherit anyway. A target naming a model the harness does not
 * list is the one shape that cannot work, because the very first `setModel`
 * of the child session refuses it.
 */
export function isAdvertisedModel(target: SessionExecutionTarget): boolean {
  const modelId = typeof target.modelId === "string" ? target.modelId : "";
  if (!modelId) return true;
  const advertised = io.modelsForHarness(target.harnessId);
  // An empty list is "we do not know", not "the model is gone" — the cache
  // guard above already refuses to answer from a non-authoritative inventory,
  // and refusing every ranking on an empty answer would disable the feature
  // exactly when discovery is briefly down.
  if (advertised.length === 0) return true;
  return advertised.some((model) => model.id === modelId);
}

/**
 * Resolves the target for one wave step, or `undefined` to inherit.
 *
 * Fail-open by construction: a missing persona, an empty inventory or a store
 * that throws all mean "no opinion", never "refuse to spawn". A wave that
 * cannot start because a preference could not be read would be a far worse
 * failure than a step running on the conductor's model.
 */
export function resolveWaveStepTarget(
  roleId: string,
  /**
   * The complexity class the plan named for this step (P36), when it named
   * one. It overrides the agent's own preference: the class is a statement
   * about the work in hand, which a standing preference cannot know about.
   */
  classId?: ModelPreferenceClassId,
): WaveStepTarget | undefined {
  try {
    const persona = resolvePersonaForRole(roleId, io.personas());
    if (!persona) return undefined;

    const policy = io.routingPolicy();
    const ranked = rankedPersonaExecutionTarget(persona, {
      providers: io.providers(),
      getModelsForHarness: io.modelsForHarness,
      rateLimits: io.rateLimits(),
      classOverrides: policy.classOverrides,
      // A wave's own threshold, stricter than a chat's by default: its steps
      // run unattended and several at once against the same meter, so a step
      // cut off mid-flight is work lost with nobody watching (P37/P38).
      nearLimitPercent: policy.waveNearLimitPercent,
      ...(classId ? { classId } : {}),
    });
    if (!ranked?.resolution.choice) return undefined;

    // L1, observed live on 2026-08-28: a whole wave of four executors was
    // spawned on `gpt-5.6-sol[low]` while codex advertised only
    // `gpt-5.6-sol[ultra]`. Every one of them died on its first send with
    // "Failed to set ACP model option: Invalid params" before doing any work,
    // and the operator paid for four empty sessions.
    //
    // Whatever composes an id the harness does not serve, this is the last
    // place that can refuse to act on it, and the check is cheap: the target
    // must name a model the harness is currently advertising. Inheriting the
    // conductor's model is a preference not applied — which is what the
    // ranking already does whenever it has nothing to say — while spawning on
    // an unserved id is a session that cannot run at all.
    if (!isAdvertisedModel(ranked.target)) return undefined;

    const { choice } = ranked.resolution;
    return {
      target: ranked.target,
      label: choice.label,
      fallback: choice.rankIndex > 0,
      nearLimit: choice.nearLimit === true,
      ...(choice.effort ? { effort: choice.effort } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * A plan pinned a step to a model the operator ranked *below* the one it
 * would otherwise have inherited.
 */
export interface WaveStepModelDowngrade {
  /** The model the plan named. */
  stepLabel: string;
  /** The model the step would have inherited from the conductor. */
  inheritedLabel: string;
}

/**
 * Whether an explicit step model is a downgrade, by the only measure this app
 * is entitled to use.
 *
 * "Weaker" is not something the app knows. Reputational priors about models
 * are a refused idea here, and inventing an ordering to warn against would be
 * exactly that idea wearing a warning's clothes. What the app does have is the
 * operator's own ranking for the step's role — a list they wrote, in the order
 * they wanted — and "the plan chose the one you put lower" is a fact about
 * that list rather than an opinion about the models.
 *
 * So: both models are located in the role's ranking, and a downgrade is only
 * reported when both are found and the step's sits later. Either one missing
 * means the ranking has no opinion about this pair, and neither has this
 * function. Never a refusal — 4a made the field legal and the operator may
 * have a reason the ranking does not know.
 */
export function checkWaveStepModelDowngrade(args: {
  roleId: string;
  step: RankableModel;
  inherited: RankableModel | undefined;
  stepLabel: string;
  inheritedLabel: string;
}): WaveStepModelDowngrade | null {
  if (!args.inherited) return null;
  try {
    const persona = resolvePersonaForRole(args.roleId, io.personas());
    if (!persona) return null;
    const source =
      parseAgentRankingSource(persona.modelRanking) ??
      (() => {
        const classId = modelPreferenceClassForPersona(persona);
        return classId ? ({ kind: "class", classId } as const) : undefined;
      })();
    if (!source) return null;
    const ranking = candidatesForRankingSource(source);
    const stepRank = rankIndexOfModel(ranking, args.step);
    const inheritedRank = rankIndexOfModel(ranking, args.inherited);
    if (stepRank < 0 || inheritedRank < 0) return null;
    if (stepRank <= inheritedRank) return null;
    return { stepLabel: args.stepLabel, inheritedLabel: args.inheritedLabel };
  } catch {
    return null;
  }
}

/** The concrete run target an explicit step `model` (4a) resolves to. */
export type ExplicitWaveStepModel =
  | {
      ok: true;
      target: SessionExecutionTarget;
      /** Operator-facing name of the matched model ("Claude Opus 5"). */
      label: string;
      /** Room left on the platform window that meters this model. */
      limit: PlatformLimitState;
    }
  | {
      ok: false;
      /** Operator-readable explanation; rendered into the refusal card. */
      detail: string;
    };

function modelDisplayName(model: ModelOption): string {
  return model.displayName || model.name || model.id;
}

/**
 * Resolves a plan's explicit step `model` against the installed inventory.
 *
 * The opposite discipline from {@link resolveWaveStepTarget}, on purpose. The
 * ranking is a preference and fails open — a preference must never stop a
 * session. An explicit model is an instruction, and D5 leaves an instruction
 * exactly two honest outcomes: applied and visible, or refused with the
 * reason. So everything that would make the ranking shrug — nothing installed,
 * a target that cannot be built, a store that throws — is a refusal here,
 * never a silent inherit.
 *
 * Matching mirrors the ranking's own two tiers (`candidateForEntry`): the
 * exact model id first, then every word of the request against the model's id
 * and display name — "opus" finds claude-opus-5 the same way a renamed
 * ranking entry does. Unlike the ranking, an ambiguous word is refused rather
 * than resolved to the first hit: see {@link matchExplicitModel}.
 *
 * The rate-limit answer is reported, not judged: admission refuses an
 * `at-limit` model (there is still time to replan), while the spawn — which
 * may run long after admission on an `access: "all"` step — honours the
 * instruction and warns instead, because failing a mid-flight wave over a
 * meter that moved is worse than the cut-off it predicts.
 */
export function resolveExplicitWaveStepModel(
  requested: string,
): ExplicitWaveStepModel {
  try {
    const needle = requested.trim().toLowerCase();
    const installed = io
      .providers()
      .flatMap((provider) =>
        io
          .modelsForHarness(provider.id)
          .map((model) => ({ harnessId: provider.id, model })),
      );
    if (installed.length === 0) {
      return {
        ok: false,
        detail: `Step model "${requested}" cannot be checked: no agent provider reports any installed models right now.`,
      };
    }

    const exact = installed.find(
      ({ model }) => model.id.trim().toLowerCase() === needle,
    );
    const matched = exact ?? matchExplicitModel(needle, installed);
    if (!matched) {
      const names = [
        ...new Set(installed.map(({ model }) => modelDisplayName(model))),
      ];
      return {
        ok: false,
        detail: `No installed model matches "${requested}". Installed models: ${names.join(", ")}.`,
      };
    }
    if ("ambiguous" in matched) {
      return { ok: false, detail: matched.ambiguous(requested) };
    }

    const { harnessId, model } = matched;
    const label = modelDisplayName(model);
    const limit = platformLimitState(io.rateLimits(), harnessId, {
      // Fable's own weekly allowance meters Fable alone; without the scope a
      // spent window on ONE model would refuse every model on the platform.
      scopedWindow: scopedWindowForModel(
        harnessId as AgentPlatformId,
        model.id,
        label,
      ),
    });

    return {
      ok: true,
      // Same provider reasoning as `rankedPersonaExecutionTarget`: the model's
      // own provider id, because a harness that fans several providers into
      // one list is not itself a provider.
      target: normalizeSessionExecutionTarget({
        harnessId,
        modelProviderId: model.providerId ?? harnessId,
        modelId: model.id,
        modelName: label,
      }),
      label,
      limit,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `Step model "${requested}" could not be resolved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/** One installed model, as this resolution sees it. */
interface InstalledModel {
  harnessId: string;
  model: ModelOption;
}

/** A word specific enough to be a model name rather than a wildcard. */
const MIN_MODEL_TOKEN_LENGTH = 3;

/**
 * Finds the one installed model a plan's word means, or says why there is not
 * exactly one.
 *
 * The ranking may take the first hit — it is expressing a preference over a
 * list the operator wrote. A plan's `model` is an instruction, and WAVES is
 * explicit that a step naming a model the harness does not serve must refuse
 * the plan rather than run on something else. "The first id containing all
 * these letters" is precisely running on something else:
 *
 * - `"5"` or `"."` matched almost every id in the inventory, so a degenerate
 *   name silently picked whatever happened to be listed first. A name now has
 *   to carry one word of at least {@link MIN_MODEL_TOKEN_LENGTH} characters.
 * - `"gpt-5"` matches `gpt-5.6-sol[low]`, `[medium]` and `[ultra]`, and
 *   inventories list tiers ascending — so the plan's word resolved to the
 *   weakest tier of a model it never asked for (the same shape as the L1
 *   incident). Several ids for one model are a refusal unless the plan named
 *   the tier, which `splitEmbeddedReasoning` reads out of the word itself.
 * - Two different models matching one word is a refusal outright; nothing here
 *   is entitled to prefer one model over another.
 *
 * The refusal carries the candidates, so the conductor's replan can name one.
 */
function matchExplicitModel(
  needle: string,
  installed: readonly InstalledModel[],
): InstalledModel | { ambiguous: (requested: string) => string } | undefined {
  const tokens = needle.split(/[^a-z0-9.]+/).filter((word) => word.length > 0);
  if (tokens.length === 0) return undefined;
  if (!tokens.some((word) => word.length >= MIN_MODEL_TOKEN_LENGTH)) {
    return {
      ambiguous: (requested) =>
        `Step model "${requested}" is too vague to match a model; name at least ${MIN_MODEL_TOKEN_LENGTH} characters of the model's name.`,
    };
  }

  const matches = installed.filter(({ model }) => {
    const haystack =
      `${model.id} ${model.displayName ?? ""} ${model.name ?? ""}`.toLowerCase();
    return tokens.every((word) => haystack.includes(word));
  });
  if (matches.length === 0) return undefined;

  const idOf = ({ model }: InstalledModel) => model.id.trim().toLowerCase();
  const distinctIds = new Set(matches.map(idOf));
  // One model, however many providers list it: the step runs on that model
  // either way, which is what the plan named.
  if (distinctIds.size === 1) return matches[0];

  const baseOf = (entry: InstalledModel) =>
    splitEmbeddedReasoning(entry.model.id)?.base.trim().toLowerCase() ??
    idOf(entry);
  const bases = new Set(matches.map(baseOf));
  const candidates = [
    ...new Set(matches.map(({ model }) => modelDisplayName(model))),
  ].join(", ");
  if (bases.size > 1) {
    return {
      ambiguous: (requested) =>
        `Step model "${requested}" matches more than one installed model (${candidates}); name one of them exactly.`,
    };
  }

  // One model served as several reasoning tiers. The plan may name the tier
  // ("gpt-5.6-sol[medium]"); otherwise picking one for it would be choosing
  // how hard the step thinks on the plan's behalf.
  const wanted = splitEmbeddedReasoning(needle)?.effort;
  if (wanted) {
    const tier = matches.filter(
      (entry) => splitEmbeddedReasoning(entry.model.id)?.effort === wanted,
    );
    if (tier.length > 0) return tier[0];
  }
  return {
    ambiguous: (requested) =>
      `Step model "${requested}" matches several reasoning tiers of the same model (${candidates}); name the one you want.`,
  };
}

/**
 * The admission-time gate for a step's explicit `model`, in the shape
 * `admitWavePlan` takes.
 *
 * Refuses what the spawn could never honestly run: a model nothing installed
 * matches, and a model whose window is already spent — starting a step the
 * meter will cut off is not "applying the operator's instruction", and at
 * admission time the conductor can still replan. A merely near-limit model is
 * admitted; the spawn says so where the operator is watching.
 */
export function checkExplicitWaveStepModel(model: string): WaveStepModelCheck {
  const resolved = resolveExplicitWaveStepModel(model);
  if (!resolved.ok) return resolved;
  if (resolved.limit === "at-limit") {
    return {
      ok: false,
      detail: `The model "${resolved.label}" is at its usage limit right now, so the step would be cut off. Re-send the plan without "model", or name another model.`,
    };
  }
  return { ok: true };
}
