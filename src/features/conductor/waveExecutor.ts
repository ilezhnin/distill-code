import {
  applicationExecutorConfiguration,
  applicationExecutorTask,
  type ApplicationExecutorOption,
} from "@/features/benchmarks/lib/applicationExecutor";
import { executorSelection } from "@/features/benchmarks/lib/executorSelection";
import type { WaveSpawnRequest, WaveState } from "./waveEngine";
import type { SessionNode } from "./types";
import { BoundedSet } from "./boundedSet";
import {
  advertisedModelForTarget,
  conductorExecutionTarget,
  isAdvertisedModel,
  planWaveStepRunSettings,
  resolveWaveStepTargets,
  waveExecutorRoleContext,
} from "./waveStepTarget";

/** Stable across renderer restarts; the wave and step persist this join. */
export function waveExecutorKey(waveId: string, stepIndex: number): string {
  return `wave:${waveId}:step:${stepIndex}`;
}

export async function prepareWaveExecutor(
  wave: WaveState,
  request: WaveSpawnRequest,
  prompt: string,
  baseline: {
    target?: ApplicationExecutorOption["target"];
    runSettings?: ApplicationExecutorOption["runSettings"];
    ranked?: boolean;
  },
) {
  const inherited =
    baseline.target ?? conductorExecutionTarget(wave.conductorSessionId);
  const options: ApplicationExecutorOption[] = inherited
    ? [{ target: inherited, runSettings: baseline.runSettings }]
    : [];
  if (!request.step.model) {
    for (const ranked of resolveWaveStepTargets(
      request.step.role,
      request.step.modelClass,
    )) {
      options.push({
        target: ranked.target,
        runSettings: planWaveStepRunSettings({
          step: request.step,
          ranked,
          model: advertisedModelForTarget(ranked.target),
        }).runSettings,
      });
    }
  }
  const rows = new Map<
    string,
    {
      configuration: NonNullable<
        ReturnType<typeof applicationExecutorConfiguration>
      >;
      option: ApplicationExecutorOption;
    }
  >();
  for (const option of options) {
    const configuration = applicationExecutorConfiguration(option);
    if (!configuration || rows.has(configuration.id)) continue;
    // The native boundary considers at most 32 distinct candidates. Keep the
    // baseline (and explicit pin) first, including its unspecified settings.
    if (rows.size === 32) break;
    rows.set(configuration.id, { configuration, option });
  }
  const candidates = [...rows.values()].map(({ configuration, option }) => ({
    configuration,
    available: waveExecutorAvailable(request, option, baseline.ranked === true),
    reason: null,
  }));
  const requestKey = waveExecutorKey(wave.waveId, request.stepIndex);
  const existing = await executorSelection.get(requestKey);
  if (existing?.observations.length) {
    throw new Error(
      "This wave step already has a recorded execution; refusing another dispatch",
    );
  }
  const decision = await executorSelection.select(
    {
      requestKey,
      surface: "wave",
      contextId: wave.waveId,
      task: applicationExecutorTask({
        prompt,
        roleId: request.step.role,
        ...waveExecutorRoleContext(request.step.role, request.step.modelClass),
        timeoutSeconds:
          request.step.budget?.minutes !== undefined
            ? request.step.budget.minutes * 60
            : undefined,
      }),
      targetFamily: wave.rootRequestId,
      targetGroup: wave.rootRequestId,
      candidates,
      priorIds: candidates.map((row) => row.configuration.id),
      hardCandidateId: request.step.model
        ? (candidates[0]?.configuration.id ?? null)
        : null,
      modelId: null,
      minQuality: 0,
    },
    true,
  );
  const selected = decision.chosen
    ? rows.get(decision.chosen.id)?.option
    : undefined;
  if (decision.chosen && !selected)
    return {
      requestKey,
      selected,
      decision,
      error: "Executor selection returned an unknown inventory row",
    };
  if (!selected && (baseline.target?.modelId || candidates.length > 0)) {
    return {
      requestKey,
      selected,
      decision,
      error: `No executor selected: ${decision.reason}`,
    };
  }
  return { requestKey, selected, decision };
}

const recordedOutcomes = new BoundedSet(1000);
const outcomesInFlight = new Set<string>();
const failedOutcomes = new Map<string, number>();

/** Reconcile persisted graph outcomes, including after a renderer restart. */
export function syncWaveExecutorOutcomes(
  nodes: readonly SessionNode[],
  onError: (node: SessionNode, error: unknown) => void,
): void {
  for (const node of nodes) {
    if (
      node.managedBy !== "wave" ||
      !node.waveId ||
      node.stepIndex === undefined ||
      !node.runId
    )
      continue;
    const outcome = node.status === "stopped" ? "cancelled" : node.status;
    if (
      outcome !== "completed" &&
      outcome !== "failed" &&
      outcome !== "cancelled"
    )
      continue;
    const key = waveExecutorKey(node.waveId, node.stepIndex);
    if (
      recordedOutcomes.has(key) ||
      outcomesInFlight.has(key) ||
      Date.now() < (failedOutcomes.get(key) ?? 0)
    )
      continue;
    outcomesInFlight.add(key);
    void (async () => {
      const record = await executorSelection.get(key);
      // Old waves predate the journal. Never manufacture a selection for them.
      if (
        !record ||
        record.observations.some((row) => row.observation.phase === "terminal")
      ) {
        recordedOutcomes.add(key);
        return;
      }
      await executorSelection.observe(key, {
        phase: "terminal",
        sessionId: node.sessionId,
        runId: node.runId,
        configuration: null,
        outcome,
        reason:
          "Conductor run status; provider configuration was not captured. Completion is not a quality verdict.",
      });
      recordedOutcomes.add(key);
      failedOutcomes.delete(key);
    })()
      .catch((error: unknown) => {
        if (!failedOutcomes.has(key)) onError(node, error);
        failedOutcomes.set(key, Date.now() + 30_000);
        if (failedOutcomes.size > 1000)
          failedOutcomes.delete(failedOutcomes.keys().next().value as string);
      })
      .finally(() => outcomesInFlight.delete(key));
  }
}

export function resetWaveExecutorOutcomesForTests(): void {
  recordedOutcomes.clear();
  outcomesInFlight.clear();
  failedOutcomes.clear();
}

/** Recheck live inventory and quota eligibility immediately before dispatch. */
export function waveExecutorAvailable(
  request: WaveSpawnRequest,
  option: ApplicationExecutorOption,
  requireRanking: boolean,
): boolean {
  if (request.step.model)
    return Boolean(advertisedModelForTarget(option.target));
  if (!requireRanking) return isAdvertisedModel(option.target);
  const id = applicationExecutorConfiguration(option)?.id;
  return resolveWaveStepTargets(
    request.step.role,
    request.step.modelClass,
  ).some((ranked) => {
    const runSettings = planWaveStepRunSettings({
      step: request.step,
      ranked,
      model: advertisedModelForTarget(ranked.target),
    }).runSettings;
    return (
      applicationExecutorConfiguration({ target: ranked.target, runSettings })
        ?.id === id
    );
  });
}

/** A failure before session creation must not masquerade as an observed model. */
export async function closeUnstartedWaveExecutor(
  requestKey: string,
  outcome: "cancelled" | "blocked" | "failed",
  reason: string,
) {
  await executorSelection.observe(requestKey, {
    phase: "terminal",
    sessionId: null,
    runId: null,
    configuration: null,
    outcome,
    reason: reason.slice(0, 4096),
  });
}
