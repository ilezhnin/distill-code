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
  advertisedEffortId,
  modelPreferenceClassForPersona,
  preferCurrentMatches,
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
  normalizeSessionRunSettings,
  type EffortValue,
  type SessionRunSettings,
} from "@/features/chat/lib/sessionRunSettings";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
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
import { splitLegacyFoldedModelId } from "@/shared/lib/foldedModelId";

import type { WaveStep } from "./distillWave";
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
   * Reasoning effort the ranking asked for, when it named one (P36) — the
   * ranked target's `runSettings.effort`.
   *
   * The ranking's profiles differ by effort as much as by model — "medium
   * engineering at medium, heavy at xhigh" is the whole difference between two
   * of them — and the model id never carries it. The spawn hands it to the
   * child as its run-settings intent; without it `coding-simple` and
   * `coding-complex` would route identically.
   */
  effort?: EffortValue;
  /**
   * `false` when the picked model advertises its efforts and `effort` is not
   * among them. The step still runs on that model: a ranking is a preference
   * and fails open.
   */
  effortApplied?: boolean;
  /** Fast mode the ranking asked for, when it stated one. */
  fast?: boolean;
  /** `false` when fast mode was asked for and the picked model has none. */
  fastApplied?: boolean;
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
  /** The conductor's own target, which a step with no model inherits. */
  conductorTarget: (sessionId: string) => SessionExecutionTarget | undefined;
}

const liveIo: WaveStepTargetIo = {
  conductorTarget: (sessionId) =>
    useChatSessionStore.getState().getSession(sessionId)?.executionTarget,
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
      ...(ranked.runSettings.effort
        ? { effort: ranked.runSettings.effort }
        : {}),
      ...(choice.effortApplied !== undefined
        ? { effortApplied: choice.effortApplied }
        : {}),
      ...(ranked.runSettings.fast !== undefined
        ? { fast: ranked.runSettings.fast }
        : {}),
      ...(choice.fastApplied !== undefined
        ? { fastApplied: choice.fastApplied }
        : {}),
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
      /** The installed row the step resolved to, capabilities included. */
      model: ModelOption;
      /**
       * The effort a legacy model string carried inside its name
       * (`gpt-5.6-sol[xhigh]`), split off because the row it matched is the
       * base model. Absent when the plan wrote the model alone, and when the
       * row is itself still a folded id from an old inventory.
       */
      legacyEffort?: string;
    }
  | {
      ok: false;
      /** Operator-readable explanation; rendered into the refusal card. */
      detail: string;
    };

/** How a wave notice names an installed model ("Claude Opus 5"). */
export function modelDisplayName(model: ModelOption): string {
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
 * ranking entry does. Several word matches narrow to the family's current
 * model ({@link preferCurrentMatches}): "opus" is Opus 5, not the Opus 4.8 or
 * the "default" alias the harness also lists. What is still ambiguous after
 * that is refused rather than resolved to the first hit: see
 * {@link matchExplicitModel}.
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
      // Deliberate, and a behaviour change worth stating: `modelsForHarness`
      // reports nothing for a harness whose last poll failed, so a transient
      // outage across every provider turns a plan that names a real, installed
      // model into a whole-plan refusal where it used to be admitted with the
      // step inheriting the conductor's model.
      //
      // That is the better of the two failures. WAVES requires that "a step
      // that names a model the harness does not serve MUST cause the whole plan
      // to be refused rather than the step to be run on something else", and
      // silently running the step on the conductor's model is exactly running
      // it on something else. This refusal is loud, says what happened, and is
      // retryable by the conductor's own replan the moment a poll succeeds.
      return {
        ok: false,
        detail: `Step model "${requested}" cannot be checked: no agent provider reports any installed models right now.`,
      };
    }

    const exact = installed.find(
      ({ model }) => model.id.trim().toLowerCase() === needle,
    );
    // A model string written before effort was its own field may still carry
    // one inside its name. Only a known effort word splits — `opus[1m]` names
    // a context lane and stays whole — and only after the exact string failed
    // to match, so an inventory that still lists folded ids keeps working.
    const folded = exact ? null : splitLegacyFoldedModelId(requested);
    const modelNeedle = folded ? folded.modelId.trim().toLowerCase() : needle;
    const matched =
      exact ??
      installed.find(
        ({ model }) => model.id.trim().toLowerCase() === modelNeedle,
      ) ??
      matchExplicitModel(modelNeedle, installed, folded?.effort);
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

    // The effort only travels separately when the row is the base model; a
    // row that is itself `gpt-5.6-sol[medium]` already runs at that tier.
    const legacyEffort =
      folded && !splitLegacyFoldedModelId(model.id) ? folded.effort : undefined;

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
      model,
      ...(legacyEffort ? { legacyEffort } : {}),
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
 *   the tier, which the caller reads out of the plan's model string with
 *   `splitLegacyFoldedModelId` and passes as `wantedEffort`. Only an old
 *   inventory still lists folded ids; a current one lists each model once.
 * - Two different models matching one word is a refusal outright; nothing here
 *   is entitled to prefer one model over another.
 *
 * The refusal carries the candidates, so the conductor's replan can name one.
 */
function matchExplicitModel(
  needle: string,
  installed: readonly InstalledModel[],
  wantedEffort?: string,
): InstalledModel | { ambiguous: (requested: string) => string } | undefined {
  const tokens = needle.split(/[^a-z0-9.]+/).filter((word) => word.length > 0);
  if (tokens.length === 0) return undefined;
  if (!tokens.some((word) => word.length >= MIN_MODEL_TOKEN_LENGTH)) {
    return {
      ambiguous: (requested) =>
        `Step model "${requested}" is too vague to match a model; name at least ${MIN_MODEL_TOKEN_LENGTH} characters of the model's name.`,
    };
  }

  const wordMatches = installed.filter(({ model }) => {
    const haystack =
      `${model.id} ${model.displayName ?? ""} ${model.name ?? ""}`.toLowerCase();
    return tokens.every((word) => haystack.includes(word));
  });
  if (wordMatches.length === 0) return undefined;
  // A family word names the family's current model, not the older generation
  // or the alias row a harness also lists ("opus" is Opus 5). Only what is
  // still ambiguous after that is refused below.
  const matches = preferCurrentMatches(wordMatches, ({ model }) => model);

  const idOf = ({ model }: InstalledModel) => model.id.trim().toLowerCase();
  const distinctIds = new Set(matches.map(idOf));
  // One model, however many providers list it: the step runs on that model
  // either way, which is what the plan named.
  if (distinctIds.size === 1) return matches[0];

  const baseOf = (entry: InstalledModel) =>
    splitLegacyFoldedModelId(entry.model.id)?.modelId.trim().toLowerCase() ??
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
  const wanted = wantedEffort?.toLowerCase();
  if (wanted) {
    const tier = matches.filter(
      (entry) => splitLegacyFoldedModelId(entry.model.id)?.effort === wanted,
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

/**
 * The installed row a target names, or `undefined` when nobody can say.
 *
 * A session still pinned to a folded id from before effort was its own field
 * is the base model as far as capabilities go, so the base row answers for it.
 */
export function advertisedModelForTarget(
  target: SessionExecutionTarget | undefined,
): ModelOption | undefined {
  const modelId = typeof target?.modelId === "string" ? target.modelId : "";
  if (!target || !modelId) return undefined;
  const rows = io.modelsForHarness(target.harnessId);
  const base = splitLegacyFoldedModelId(modelId)?.modelId;
  return (
    rows.find((row) => row.id === modelId) ??
    (base ? rows.find((row) => row.id === base) : undefined)
  );
}

/** The conductor's own target: what a step with no model of its own runs on. */
export function conductorExecutionTarget(
  conductorSessionId: string,
): SessionExecutionTarget | undefined {
  try {
    return io.conductorTarget(conductorSessionId);
  } catch {
    return undefined;
  }
}

export interface WaveStepRunSettingsJudgement {
  /** What the child is asked to run at, the effort in the model's own spelling. */
  runSettings: SessionRunSettings | undefined;
  /** `false` when the model lists its efforts and the asked-for one is not there. */
  effortApplied: boolean;
  /** `false` when fast mode was asked for and the model says it has none. */
  fastApplied: boolean;
  /** The effort ids the model offers, when it says. */
  offeredEfforts?: readonly string[];
}

/**
 * Judges an effort and fast mode against one model's advertised capabilities.
 *
 * Unknown is not "no". A model whose efforts nobody has read, or a target whose
 * row is not in the inventory, passes: the same fail-open rule
 * {@link isAdvertisedModel} keeps for an empty inventory, so a discovery outage
 * never refuses a plan over a capability nobody could see. A value the model
 * does not honour stays in the returned intent — the child keeps it, and the
 * run-settings reconciler shows what runs instead.
 */
export function judgeWaveStepRunSettings(
  model: Pick<ModelOption, "efforts" | "supportsFast"> | undefined,
  requested: SessionRunSettings,
): WaveStepRunSettingsJudgement {
  const spelled =
    requested.effort && model
      ? advertisedEffortId(model, requested.effort)
      : undefined;
  return {
    runSettings: normalizeSessionRunSettings({
      ...(requested.effort ? { effort: spelled ?? requested.effort } : {}),
      ...(requested.fast !== undefined ? { fast: requested.fast } : {}),
    }),
    effortApplied: spelled !== null,
    fastApplied: !(requested.fast === true && model?.supportsFast === false),
    ...(model?.efforts
      ? { offeredEfforts: model.efforts.map((option) => option.id) }
      : {}),
  };
}

/**
 * What a wave step asks its child to run at.
 *
 * The step's own fields win: an `effort` the plan wrote beats one carried
 * inside a legacy model string, and both beat the ranking's.
 */
export function planWaveStepRunSettings(args: {
  step: Pick<WaveStep, "effort" | "fast">;
  legacyEffort?: string;
  ranked?: Pick<WaveStepTarget, "effort" | "fast">;
  /** The row of the model the step runs on, when it is known. */
  model: ModelOption | undefined;
}): WaveStepRunSettingsJudgement {
  const effort = args.step.effort ?? args.legacyEffort ?? args.ranked?.effort;
  const fast = args.step.fast ?? args.ranked?.fast;
  return judgeWaveStepRunSettings(args.model, {
    ...(effort ? { effort } : {}),
    ...(fast !== undefined ? { fast } : {}),
  });
}

/**
 * The admission-time gate for a step's own `effort` and `fast`, in the shape
 * `admitWavePlan` takes.
 *
 * An effort or fast mode the plan named is an instruction, exactly like a
 * named model, so the discipline is the same: a value the model the step will
 * run on does not offer refuses the whole plan, naming what IS offered, while
 * the conductor can still replan. The model is the plan's own when it named
 * one, else the role's ranking, else the conductor's.
 *
 * What the ranking asks for is not judged here — a ranking is a preference and
 * fails open at the spawn with a notice. Neither is anything this gate cannot
 * read: an unresolvable model is the model check's refusal, with its own
 * reason, and a store that throws admits the step, whose spawn re-judges it.
 */
export function checkWaveStepRunSettings(
  step: WaveStep,
  conductorSessionId: string,
): WaveStepModelCheck {
  try {
    const legacyEffort =
      step.model && !step.effort
        ? splitLegacyFoldedModelId(step.model)?.effort
        : undefined;
    if (!step.effort && step.fast !== true && !legacyEffort) {
      return { ok: true };
    }

    let model: ModelOption | undefined;
    let label: string | undefined;
    let effort = step.effort;
    if (step.model) {
      const resolved = resolveExplicitWaveStepModel(step.model);
      if (!resolved.ok) return { ok: true };
      model = resolved.model;
      label = resolved.label;
      effort = step.effort ?? resolved.legacyEffort;
    } else {
      const ranked = resolveWaveStepTarget(step.role, step.modelClass);
      model = advertisedModelForTarget(
        ranked?.target ?? conductorExecutionTarget(conductorSessionId),
      );
      label = ranked?.label;
    }
    if (!model) return { ok: true };

    const name = label ?? modelDisplayName(model);
    const judged = judgeWaveStepRunSettings(model, {
      ...(effort ? { effort } : {}),
      ...(step.fast !== undefined ? { fast: step.fast } : {}),
    });
    const problems: string[] = [];
    if (effort && !judged.effortApplied) {
      const offered = judged.offeredEfforts ?? [];
      problems.push(
        offered.length > 0
          ? `The model "${name}" does not offer the reasoning effort "${effort}"; it offers ${offered.join(", ")}.`
          : `The model "${name}" offers no reasoning effort choices, so "effort": "${effort}" cannot apply. Re-send the plan without "effort".`,
      );
    }
    if (!judged.fastApplied) {
      problems.push(
        `The model "${name}" has no fast mode. Re-send the plan without "fast", or name a model that has one.`,
      );
    }
    return problems.length > 0
      ? { ok: false, detail: problems.join(" ") }
      : { ok: true };
  } catch {
    return { ok: true };
  }
}
