import {
  applicationExecutorPriorIds,
  applicationExecutorConfiguration,
  applicationExecutorTask,
  type ApplicationExecutorOption,
} from "@/features/benchmarks/lib/applicationExecutor";
import {
  executorSelection,
  type ExecutorDecision,
  type ExecutorDecisionRecord,
} from "@/features/benchmarks/lib/executorSelection";
import {
  ownedTaskExecution,
  isOwnedTaskModeV2,
  type OwnedTaskModeV2,
  type PlannedOwnedStep,
  type PreparedOwnedTask,
} from "@/features/benchmarks/lib/ownedTaskExecution";
import { benchmarkGovernanceApi } from "@/features/benchmarks/api/benchmarkGovernance";
import { taskBindingId } from "@/features/chat/lib/executionOwnership";
import type { WaveSpawnRequest, WaveState, WaveStepState } from "./waveEngine";
import type { SessionNode } from "./types";
import { BoundedSet } from "./boundedSet";
import {
  automaticWaveExecutorOptions,
  advertisedModelForTarget,
  conductorExecutionTarget,
  isAdvertisedModel,
  modelDisplayName,
  planWaveStepRunSettings,
  resolveWaveStepTargets,
  waveExecutorRoleContext,
} from "./waveStepTarget";

/** Explicit step settings constrain every automatic candidate, not only the prior. */
function automaticOptionsForStep(
  request: WaveSpawnRequest,
  preferred: readonly ApplicationExecutorOption[],
): ApplicationExecutorOption[] {
  return automaticWaveExecutorOptions(preferred).flatMap((option) => {
    const judged = planWaveStepRunSettings({
      step: request.step,
      ranked: option.runSettings,
      model: advertisedModelForTarget(option.target),
    });
    if (
      (request.step.effort && !judged.effortApplied) ||
      (request.step.fast === true && !judged.fastApplied)
    )
      return [];
    return [{ target: option.target, runSettings: judged.runSettings }];
  });
}

/** Stable across renderer restarts; the wave and step persist this join. */
export function waveExecutorKey(waveId: string, stepIndex: number): string {
  return `wave:${waveId}:step:${stepIndex}`;
}

/**
 * The native context every owned step of one root request shares. The host
 * admits wave contexts under the conductor's `:wave:` namespace only.
 */
export function ownedWaveRootContextId(wave: WaveState): string {
  return `${wave.conductorSessionId}:wave:root:${wave.rootRequestId}`;
}

/**
 * The native lineage a revision of this wave continues: the earlier waves'
 * lineage, then this wave's owned steps whose children completed, in step
 * order. A step after the first failure is never bound by the host, so the
 * completed steps are exactly the committed prefix.
 */
export function ownedWaveLineage(
  wave: WaveState,
  statusOf: (stepIndex: number) => string | undefined,
): string[] {
  const own = [...wave.steps]
    .sort((left, right) => left.stepIndex - right.stepIndex)
    .flatMap((step) => {
      const binding = step.sessionId ? taskBindingId(step.sessionId) : null;
      return binding && statusOf(step.stepIndex) === "completed"
        ? [binding]
        : [];
    });
  return [...(wave.carriedBindingIds ?? []), ...own];
}

/** The acknowledged native role source, class and time allowance of a step. */
function ownedStepShape(
  mode: OwnedTaskModeV2,
  step: Pick<WaveStepState, "role" | "modelClass" | "budget">,
): PlannedOwnedStep {
  const roles = mode.consent.roles.filter(
    (role) =>
      role.roleId === step.role &&
      (!step.modelClass || role.workClassId === step.modelClass),
  );
  if (roles.length !== 1)
    throw new Error(
      "The wave role/class does not identify one acknowledged native role source",
    );
  const budget = step.budget;
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
  return {
    roleSourceId: roles[0].sourceId,
    workClassId: roles[0].workClassId,
    stepBudgetSeconds: seconds,
  };
}

/**
 * The whole planned step sequence a wave root sends, so the host can find a
 * certificate for that exact trajectory. A step that cannot resolve its own
 * native shape fails at its own spawn; the root then simply plans nothing.
 */
function ownedWavePlan(
  mode: OwnedTaskModeV2,
  wave: WaveState,
): PlannedOwnedStep[] | null {
  if (wave.steps.length < 2 || wave.steps.length > 16) return null;
  try {
    return [...wave.steps]
      .sort((left, right) => left.stepIndex - right.stepIndex)
      .map((step) => ownedStepShape(mode, step));
  } catch {
    return null;
  }
}

/** What a step's dispatch resolved to before any session is created. */
export interface PreparedWaveExecutor {
  requestKey: string;
  decision: ExecutorDecision;
  selected: ApplicationExecutorOption | undefined;
  /** Why nothing can be dispatched, when nothing can. */
  error?: string;
  owned?: PreparedOwnedTask;
  /** A session another process already started for this step: adopt it. */
  adopt?: { sessionId: string; runId: string | null };
  /** The recorded choice vanished from the inventory; this row runs instead. */
  fallbackNote?: string;
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
): Promise<PreparedWaveExecutor> {
  const mode = await ownedTaskExecution.getMode(wave.conductorSessionId);
  if (mode && isOwnedTaskModeV2(mode)) {
    const carried = wave.carriedBindingIds ?? [];
    // A revision continues the root request's lineage and root budget; it
    // never opens a fresh root for work the earlier waves already spent.
    if ((wave.revisionCount || wave.carriedReports?.length) && !carried.length)
      throw new Error(
        "This owned revision has no completed native step of the earlier wave to continue from; start a new request instead",
      );
    const shape = ownedStepShape(mode, request.step);
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
    const previousBindingIds = [...wave.steps]
      .sort((left, right) => left.stepIndex - right.stepIndex)
      .filter((step) => step.stepIndex < request.stepIndex)
      .map((step) => (step.sessionId ? taskBindingId(step.sessionId) : null));
    if (previousBindingIds.some((id) => !id))
      throw new Error(
        "Native v2 wave entry needs committed predecessor bindings",
      );
    const predecessorIds = [
      ...carried,
      ...previousBindingIds.filter((id): id is string => Boolean(id)),
    ];
    // Every step of a lineage shares its root's native context; a root made
    // before the per-request context keeps its own.
    const contextId = predecessorIds.length
      ? (await ownedTaskExecution.get(predecessorIds[0])).binding.request
          .contextId
      : ownedWaveRootContextId(wave);
    const owned = await ownedTaskExecution.prepare({
      schemaVersion: 2,
      requestKey: waveExecutorKey(wave.waveId, request.stepIndex),
      surface: "wave",
      contextId,
      mode: {
        contextId: wave.conductorSessionId,
        artifactHash: mode.artifactHash,
      },
      roleSourceId: shape.roleSourceId,
      workClassId: shape.workClassId,
      prompt: request.step.subtask,
      hardCandidateKey,
      stepBudgetSeconds: shape.stepBudgetSeconds,
      entry: predecessorIds.length
        ? {
            rootBindingId: predecessorIds[0],
            previousBindingIds: predecessorIds,
            includePreviousOutput: request.step.access === "all",
          }
        : null,
      // Only a fresh root plans; its later steps inherit the root's plan.
      plannedTrajectory: predecessorIds.length
        ? null
        : ownedWavePlan(mode, wave),
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
  const candidatesWithEffort = request.step.model
    ? options
    : automaticOptionsForStep(request, options);
  const priorIds = new Set(
    options.map((option) => applicationExecutorConfiguration(option)?.id),
  );
  for (const option of candidatesWithEffort) {
    const configuration = applicationExecutorConfiguration(option);
    if (!configuration || rows.has(configuration.id)) continue;
    rows.set(configuration.id, { configuration, option });
  }
  const candidates = [...rows.values()].map(({ configuration, option }) => ({
    configuration,
    // The automatic pool already applied live inventory/quota/settings checks.
    // Avoid rebuilding that full pool for each row; the winner is rechecked
    // by waveExecutorAvailable immediately before dispatch.
    available: Boolean(advertisedModelForTarget(option.target)),
    reason: null,
  }));
  const baseKey = waveExecutorKey(wave.waveId, request.stepIndex);
  // A resumed step is a new dispatch of the same step and gets a key of its
  // own, so the record of the session the restart ended stays whole.
  const resolved = await resolveWaveExecutorRecord(
    request.resume
      ? `${baseKey}:resume:${request.resume.resumeCount}`
      : baseKey,
  );
  if (resolved.kind === "started") {
    // Another process already started a session for this very step (the
    // previous run of this app, or a second Flock on the same folder). Hand
    // it back to be adopted instead of starting a second worker beside it.
    return {
      requestKey: resolved.requestKey,
      decision: resolved.record.decision,
      selected: undefined,
      adopt: resolved.session,
      owned: undefined as PreparedOwnedTask | undefined,
    };
  }
  const requestKey = resolved.requestKey;
  const existing = resolved.kind === "decided" ? resolved.record : null;
  // A decision already on record with nothing dispatched on it is the one
  // this step runs on. That is a spawn that died between deciding and
  // starting — the renderer went down mid-spawn and the restarted engine is
  // resuming the step — and the key is immutable: deciding again would hand
  // the host the inputs as they are now (the inventory moved while the
  // bridges came back) for a key it has already answered, and it refuses that
  // rather than start a worker. The decision is still checked against the
  // live inventory below, like a fresh one.
  const decision =
    existing?.decision ??
    (await executorSelection.select(
      {
        requestKey,
        surface: "wave",
        contextId: wave.waveId,
        task: applicationExecutorTask({
          prompt,
          roleId: request.step.role,
          ...waveExecutorRoleContext(
            request.step.role,
            request.step.modelClass,
          ),
          timeoutSeconds:
            request.step.budget?.minutes !== undefined
              ? request.step.budget.minutes * 60
              : undefined,
        }),
        targetFamily: wave.rootRequestId,
        targetGroup: wave.rootRequestId,
        candidates,
        priorIds: applicationExecutorPriorIds(candidates, priorIds),
        hardCandidateId: request.step.model
          ? (candidates[0]?.configuration.id ?? null)
          : null,
        modelId: null,
        minQuality: 0,
      },
      true,
    ));
  let selected = decision.chosen
    ? rows.get(decision.chosen.id)?.option
    : undefined;
  let fallbackNote: string | undefined;
  if (decision.chosen && !selected) {
    // The recorded choice names a row the live inventory no longer has (the
    // model cache moved between the decision and this dispatch). The next
    // row the ranking offers runs the step, and the digest says so; only when
    // nothing at all is left does the step fail.
    const fallback = [...rows.values()].find(
      ({ option }) =>
        option !== undefined &&
        Boolean(advertisedModelForTarget(option.target)),
    );
    if (fallback) {
      selected = fallback.option;
      const model = advertisedModelForTarget(fallback.option.target);
      const label = model
        ? modelDisplayName(model)
        : (fallback.option.target.modelName ??
          String(fallback.option.target.modelId ?? fallback.configuration.id));
      fallbackNote = `Executor selection chose "${decision.chosen.id}", which is no longer in the model inventory; the step runs on ${label} instead.`;
    } else {
      return {
        requestKey,
        selected,
        decision,
        error: `Executor selection chose "${decision.chosen.id}", which is no longer in the model inventory, and no other candidate is available`,
      };
    }
  }
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
    ...(fallbackNote ? { fallbackNote } : {}),
    owned: undefined as PreparedOwnedTask | undefined,
  };
}

/** What the journal already holds for a step's request key. */
type WaveExecutorRecordResolution =
  | { kind: "fresh"; requestKey: string }
  | { kind: "decided"; requestKey: string; record: ExecutorDecisionRecord }
  | {
      kind: "started";
      requestKey: string;
      record: ExecutorDecisionRecord;
      session: { sessionId: string; runId: string | null };
    };

/** Bound on numbered keys one step may use up; each is a dispatch that died. */
const MAX_WAVE_EXECUTOR_ATTEMPTS = 8;

/**
 * Reads the journal for a step and says what this dispatch may do with it.
 *
 * A record with a session on it is a worker that exists: it is adopted. A
 * record whose only observations are terminal with no session is a dispatch
 * closed before anything ran — the host answers a request key once, so the
 * next attempt runs under a numbered key instead of being refused for the
 * rest of the wave's life. A bare decision is reused as before: it was made
 * by a process that died between deciding and starting.
 */
async function resolveWaveExecutorRecord(
  baseKey: string,
): Promise<WaveExecutorRecordResolution> {
  let requestKey = baseKey;
  for (let attempt = 0; attempt <= MAX_WAVE_EXECUTOR_ATTEMPTS; attempt += 1) {
    const record = await executorSelection.get(requestKey);
    if (!record) return { kind: "fresh", requestKey };
    const session = startedWaveExecutorSession(record);
    if (session) return { kind: "started", requestKey, record, session };
    if (record.observations.length === 0 && !record.hostExecution) {
      return { kind: "decided", requestKey, record };
    }
    if (
      record.hostExecution ||
      record.observations.some((row) => row.observation.phase === "started")
    ) {
      // A session was started for this key and the record does not say
      // which. Another worker beside an unknown one is the one outcome worse
      // than a failed step, so the step fails and says what it found.
      throw new Error(
        `This wave step's execution record (${requestKey}) says a session was started but does not name it; look at the record before asking again`,
      );
    }
    requestKey = `${baseKey}:attempt:${attempt + 1}`;
  }
  throw new Error(
    `This wave step was dispatched and closed ${MAX_WAVE_EXECUTOR_ATTEMPTS} times without a session starting; look at its execution records before asking again`,
  );
}

/** The session a journal record says was started, when one was. */
function startedWaveExecutorSession(
  record: ExecutorDecisionRecord,
): { sessionId: string; runId: string | null } | null {
  const started = record.observations.find(
    (row) => row.observation.sessionId !== null,
  );
  if (started?.observation.sessionId) {
    return {
      sessionId: started.observation.sessionId,
      runId: started.observation.runId,
    };
  }
  const receipt = record.hostExecution;
  if (receipt?.start.sessionId) {
    return {
      sessionId: receipt.start.sessionId,
      runId: receipt.start.link.logicalRunId,
    };
  }
  return null;
}

const recordedOutcomes = new BoundedSet(1000);
const outcomesInFlight = new Set<string>();
const failedOutcomes = new Map<string, number>();

/** Reconcile persisted graph outcomes, including after a renderer restart. */
export function syncWaveExecutorOutcomes(
  nodes: readonly SessionNode[],
  onError: (node: SessionNode, error: unknown) => void,
  /**
   * The request key a step's dispatch was recorded under, when the wave
   * remembers one that is not the default — a numbered attempt or a resume.
   */
  executorKeyOf?: (node: SessionNode) => string | undefined,
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
      : (executorKeyOf?.(node) ?? waveExecutorKey(node.waveId, node.stepIndex));
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
  const preferred = resolveWaveStepTargets(
    request.step.role,
    request.step.modelClass,
  ).map((ranked) => ({
    target: ranked.target,
    runSettings: planWaveStepRunSettings({
      step: request.step,
      ranked,
      model: advertisedModelForTarget(ranked.target),
    }).runSettings,
  }));
  const available = automaticOptionsForStep(request, preferred);
  return available.some(
    (candidate) => applicationExecutorConfiguration(candidate)?.id === id,
  );
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
