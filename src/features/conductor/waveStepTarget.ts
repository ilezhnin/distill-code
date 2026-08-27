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

import { scopedWindowForModel } from "@/features/agents/lib/agentModelRanking";
import { rankedPersonaExecutionTarget } from "@/features/agents/lib/rankedPersonaTarget";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import {
  normalizeSessionExecutionTarget,
  type SessionExecutionTarget,
} from "@/features/chat/lib/sessionExecutionTarget";
import type { ModelOption } from "@/features/chat/types";
import {
  isCachedModelInventoryAuthoritative,
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
}

/** Test seam: everything about the world this resolution reads. */
export interface WaveStepTargetIo {
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
    const entry = useProviderModelCacheStore
      .getState()
      .providers.get(harnessId);
    return entry && isCachedModelInventoryAuthoritative(entry)
      ? entry.models
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
 * Resolves the target for one wave step, or `undefined` to inherit.
 *
 * Fail-open by construction: a missing persona, an empty inventory or a store
 * that throws all mean "no opinion", never "refuse to spawn". A wave that
 * cannot start because a preference could not be read would be a far worse
 * failure than a step running on the conductor's model.
 */
export function resolveWaveStepTarget(
  roleId: string,
): WaveStepTarget | undefined {
  try {
    const persona = resolvePersonaForRole(roleId, io.personas());
    if (!persona) return undefined;

    const ranked = rankedPersonaExecutionTarget(persona, {
      providers: io.providers(),
      getModelsForHarness: io.modelsForHarness,
      rateLimits: io.rateLimits(),
    });
    if (!ranked?.resolution.choice) return undefined;

    const { choice } = ranked.resolution;
    return {
      target: ranked.target,
      label: choice.label,
      fallback: choice.rankIndex > 0,
      nearLimit: choice.nearLimit === true,
    };
  } catch {
    return undefined;
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
 * ranking entry does. The first match in inventory order wins.
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

    const tokens = needle
      .split(/[^a-z0-9.]+/)
      .filter((word) => word.length > 0);
    const matched =
      installed.find(({ model }) => model.id.trim().toLowerCase() === needle) ??
      installed.find(({ model }) => {
        const haystack =
          `${model.id} ${model.displayName ?? ""} ${model.name ?? ""}`.toLowerCase();
        return (
          tokens.length > 0 && tokens.every((word) => haystack.includes(word))
        );
      });
    if (!matched) {
      const names = [
        ...new Set(installed.map(({ model }) => modelDisplayName(model))),
      ];
      return {
        ok: false,
        detail: `No installed model matches "${requested}". Installed models: ${names.join(", ")}.`,
      };
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
