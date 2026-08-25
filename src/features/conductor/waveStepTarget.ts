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

import { rankedPersonaExecutionTarget } from "@/features/agents/lib/rankedPersonaTarget";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import type { SessionExecutionTarget } from "@/features/chat/lib/sessionExecutionTarget";
import type { ModelOption } from "@/features/chat/types";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { useProviderRateLimitsStore } from "@/features/status/stores/providerRateLimitsStore";

import { resolvePersonaForRole } from "./roleCatalog";

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
  modelsForHarness: (harnessId) =>
    useProviderModelCacheStore.getState().providers.get(harnessId)?.models ??
    [],
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
