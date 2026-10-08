import {
  applicationExecutorConfiguration,
  applicationExecutorTask,
  type ApplicationExecutorOption,
} from "@/features/benchmarks/lib/applicationExecutor";
import { executorSelection } from "@/features/benchmarks/lib/executorSelection";
import {
  ownedTaskExecution,
  isOwnedTaskModeV2,
  type PreparedOwnedTask,
} from "@/features/benchmarks/lib/ownedTaskExecution";
import { benchmarkGovernanceApi } from "@/features/benchmarks/api/benchmarkGovernance";
import { taskBindingId } from "@/features/chat/lib/executionOwnership";
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
  const mode = await ownedTaskExecution.getMode(wave.conductorSessionId);
  if (mode && isOwnedTaskModeV2(mode)) {
    if (wave.revisionCount || wave.carriedReports?.length)
      throw new Error(
        "Carried revision context needs a committed native v2 root lineage",
      );
    const roles = mode.consent.roles.filter(
      (role) =>
        role.roleId === request.step.role &&
        (!request.step.modelClass ||
          role.workClassId === request.step.modelClass),
    );
    if (roles.length !== 1)
      throw new Error(
        "The wave role/class does not identify one acknowledged native role source",
      );
    const budget = request.step.budget;
    if (budget?.usd !== undefined || budget?.tokens !== undefined)
      throw new Error(
        "This native contract does not attest monetary or token step caps",
      );
    const seconds =
      budget?.minutes === undefined
        ? mode.consent.limits.timeoutSeconds
        : Math.floor(budget.minutes * 60);
    if (
      !Number.isSafeInteger(seconds) ||
      seconds <= 0 ||
      seconds > mode.consent.limits.timeoutSeconds
    )
      throw new Error(
        "The wave step allowance exceeds the acknowledged native root cap",
      );
    let hardCandidateKey: string | null = null;
    if (
      request.step.model ||
      request.step.effort ||
      request.step.fast !== undefined
    ) {
      const choices = await ownedTaskExecution.nativeChoices(
        wave.conductorSessionId,
      );
      const compatible = choices.filter(
        ({ configuration }) =>
          (!request.step.model ||
            (configuration.providerId === baseline.target?.harnessId &&
              configuration.modelId === baseline.target.modelId)) &&
          (!request.step.effort ||
            configuration.effort === request.step.effort) &&
          (request.step.fast === undefined ||
            configuration.fastMode === request.step.fast),
      );
      if (compatible.length !== 1 || !compatible[0].available)
        throw new Error(
          "The explicit wave pin does not identify one available native candidate/control choice",
        );
      hardCandidateKey = compatible[0].candidateKey;
    }
    const previousBindingIds = wave.steps
      .slice(0, request.stepIndex)
      .map((step) => (step.sessionId ? taskBindingId(step.sessionId) : null));
    if (previousBindingIds.some((id) => !id))
      throw new Error(
        "Native v2 wave entry needs committed predecessor bindings",
      );
    const predecessorIds = previousBindingIds.filter((id): id is string =>
      Boolean(id),
    );
    const owned = await ownedTaskExecution.prepare({
      schemaVersion: 2,
      requestKey: waveExecutorKey(wave.waveId, request.stepIndex),
      surface: "wave",
      contextId: `${wave.conductorSessionId}:wave:${wave.waveId}`,
      mode: {
        contextId: wave.conductorSessionId,
        artifactHash: mode.artifactHash,
      },
      roleSourceId: roles[0].sourceId,
      workClassId: roles[0].workClassId,
      prompt: request.step.subtask,
      hardCandidateKey,
      stepBudgetSeconds: seconds,
      entry: predecessorIds.length
        ? {
            rootBindingId: predecessorIds[0],
            previousBindingIds: predecessorIds,
            includePreviousOutput: request.step.access === "all",
          }
        : null,
    });
    return {
      requestKey: owned.binding.request.requestKey,
      decision: owned.binding.decision,
      selected: undefined,
      error: undefined,
      owned: owned as PreparedOwnedTask | undefined,
    };
  }
  if (mode?.request.promotionId) {
    const promotion = (await benchmarkGovernanceApi.listPromotions()).find(
      (row) => row.certificate.id === mode.request.promotionId,
    );
    if (
      !promotion ||
      promotion.certificate.artifactHash !==
        mode.request.acknowledgedCertificateHash
    )
      throw new Error("The acknowledged native wave certificate changed");
    if (
      request.step.role !== promotion.certificate.contract.roleId ||
      request.step.budget ||
      wave.revisionCount ||
      wave.carriedReports?.length
    )
      throw new Error(
        "This bounded wave contract needs its exact certified role and native root budget; per-step budget and carried revision context need a compatible native contract",
      );
    let hardCandidateKey: string | null = null;
    if (
      request.step.model ||
      request.step.effort ||
      request.step.fast !== undefined
    ) {
      const choices = await ownedTaskExecution.choices(
        mode.request.promotionId,
      );
      const compatible = choices.filter(
        ({ configuration }) =>
          (!request.step.model ||
            (configuration.providerId === baseline.target?.harnessId &&
              configuration.modelId === baseline.target.modelId)) &&
          (!request.step.effort ||
            configuration.effort === request.step.effort) &&
          (request.step.fast === undefined ||
            configuration.fastMode === request.step.fast),
      );
      if (compatible.length !== 1 || !compatible[0].available)
        throw new Error(
          "The explicit wave model/settings do not identify one available compatible native worker",
        );
      hardCandidateKey = compatible[0].candidateKey;
    }
    const predecessors = wave.steps
      .slice(0, request.stepIndex)
      .map((step) => (step.sessionId ? taskBindingId(step.sessionId) : null));
    if (predecessors.some((id) => !id))
      throw new Error(
        "The bounded wave needs committed native predecessors before another step",
      );
    const previousBindingIds = predecessors.filter((id): id is string =>
      Boolean(id),
    );
    const owned = await ownedTaskExecution.prepare({
      requestKey: waveExecutorKey(wave.waveId, request.stepIndex),
      surface: "wave",
      contextId: `${wave.conductorSessionId}:wave:${wave.waveId}`,
      promotionId: mode.request.promotionId,
      acknowledgedCertificateHash: mode.request.acknowledgedCertificateHash,
      prompt: request.step.subtask,
      hardCandidateKey,
      repository: mode.request.repository,
      entry: previousBindingIds.length
        ? {
            rootBindingId: previousBindingIds[0],
            previousBindingIds,
            includePreviousOutput: request.step.access === "all",
          }
        : null,
      waveMode: {
        contextId: wave.conductorSessionId,
        artifactHash: mode.artifactHash,
      },
    });
    return {
      requestKey: owned.binding.request.requestKey,
      decision: owned.binding.decision,
      selected: undefined,
      error: undefined,
      owned: owned as PreparedOwnedTask | undefined,
    };
  }
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
  if (existing?.observations.length || existing?.hostExecution) {
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
  return {
    requestKey,
    selected,
    decision,
    owned: undefined as PreparedOwnedTask | undefined,
  };
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
    const key = node.runId.startsWith("owned-task:")
      ? node.runId
      : waveExecutorKey(node.waveId, node.stepIndex);
    const runId = node.runId;
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
      let nativeOutcome = outcome;
      if (key.startsWith("owned-task:")) {
        const bindingId = taskBindingId(node.sessionId);
        if (!bindingId)
          throw new Error("Owned wave task has no native ownership binding");
        const status = await ownedTaskExecution.status(bindingId);
        if (
          !status ||
          status.phase === "reserved" ||
          status.phase === "running"
        )
          return;
        if (status.sessionId !== node.sessionId || status.requestKey !== key)
          throw new Error("Native wave attribution receipt identity changed");
        if (status.phase !== "terminal")
          throw new Error(
            "Native wave outcome is uncertain; no terminal attribution is available",
          );
        nativeOutcome = status.error
          ? status.error.kind === "cancelled"
            ? "cancelled"
            : "failed"
          : "completed";
        const receipt = record.hostExecution;
        if (
          record.decision.request.requestKey !== key ||
          receipt?.start.sessionId !== node.sessionId ||
          receipt.start.link.decisionKey !== key ||
          receipt.start.link.logicalRunId !== runId ||
          receipt.start.hostRunId !== status.runId ||
          receipt.finish?.status !== nativeOutcome
        )
          throw new Error(
            "Native wave outcome differs from its processing receipt",
          );
      }
      await executorSelection.syncOutcome(
        key,
        node.sessionId,
        runId,
        nativeOutcome,
      );
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
  // Owned setup/cleanup is recorded by its native lifecycle. A renderer
  // cannot manufacture a terminal receipt for a task that never processed.
  if (requestKey.startsWith("owned-task:")) return;
  await executorSelection.observe(requestKey, {
    phase: "terminal",
    sessionId: null,
    runId: null,
    configuration: null,
    outcome,
    reason: reason.slice(0, 4096),
  });
}
