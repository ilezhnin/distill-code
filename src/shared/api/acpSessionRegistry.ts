import * as acpApi from "./acpApi";
import { invalidateClientConnectionIfUnresponsive } from "./acpConnection";
import {
  readSessionExecutionConfigSnapshot,
  type AcpSessionConfigSnapshotContext,
  type AcpSessionConfigSnapshots,
} from "./acpSessionConfigSnapshots";
import { perfLog } from "@/shared/lib/perfLog";
import {
  logReasoningEffortInfo,
  shortLogId,
} from "@/shared/lib/reasoningEffortDiagnostics";
import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";
import { sameModelIdentity } from "@/shared/lib/foldedModelId";

export interface AcpSessionExecutionSelection {
  providerId: string;
  /** Last model this window observed ACP acknowledge successfully. */
  modelId?: string;
  /**
   * Run settings this window has already written for the CURRENT model, so a
   * repeat write is skipped the way a repeat model write is. They are dropped
   * whenever the model or the provider changes, because a fresh model answers
   * with its own values and nothing this window wrote is acknowledged for it.
   *
   * These are never compared against the execution target: effort and fast are
   * acknowledged separately from the model, so a snapshot is never dropped as
   * divergent because the effort changed.
   */
  effort?: string;
  fast?: boolean;
}

/** One ordered run-settings write pair, in the bridge's own option ids. */
export interface AcpSessionRunSettingsWrite {
  effort?: { configId: string; value: string };
  fast?: { configId: string; value: boolean; kind: "boolean" | "select" };
}

/**
 * Decides the run-settings writes that follow a provider/model apply, given the
 * answer that apply produced (undefined when nothing went over the wire because
 * the session was already there). Returning nothing, or a write with neither
 * knob, skips the step.
 */
export type AcpRunSettingsPlanner = (
  snapshots: AcpSessionConfigSnapshots | undefined,
) => AcpSessionRunSettingsWrite | undefined;

interface PreparedSession {
  workingDir: string;
  executionSelection?: AcpSessionExecutionSelection;
}

interface SessionConfigMutationOptions {
  forceConfigRefresh?: boolean;
  requestId?: string;
  planRunSettings?: AcpRunSettingsPlanner;
}

const SESSION_MUTATION_TIMEOUT_MS = 60_000;

const prepared = new Map<string, PreparedSession>();
const mutationQueues = new Map<
  string,
  { latestSequence: number; tail: Promise<void> }
>();
let nextMutationSequence = 1;

function clonePreparedSession(
  entry: PreparedSession | undefined,
): PreparedSession | undefined {
  return entry
    ? {
        ...entry,
        executionSelection: entry.executionSelection
          ? { ...entry.executionSelection }
          : undefined,
      }
    : undefined;
}

// Rebuilt, never merged: a provider or model write invalidates every run
// setting this window had acknowledged, so they must not survive into the new
// selection.
function replaceExecutionSelection(
  entry: PreparedSession,
  providerId: string,
  modelId?: string,
): void {
  entry.executionSelection = {
    providerId,
    ...(modelId ? { modelId } : {}),
  };
}

/** What a serialized mutation may ask about its own turn while it runs. */
interface SessionMutationTurn {
  /** True while no later mutation for this session has been enqueued. */
  isLatest: () => boolean;
  /**
   * True once this mutation's bound elapsed: its caller has been rejected and
   * the queue moved on without it, so anything it learns afterwards describes
   * a session another mutation now owns.
   */
  isAbandoned: () => boolean;
}

async function runBoundedSessionMutation<T>(
  sessionId: string,
  mutation: Promise<T>,
  onAbandoned: () => void,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let didTimeOut = false;
  try {
    return await Promise.race([
      mutation,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          didTimeOut = true;
          onAbandoned();
          reject(
            new Error(
              `ACP operation timed out for session ${sessionId.slice(0, 8)}. Reconnect and retry.`,
            ),
          );
        }, SESSION_MUTATION_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (didTimeOut) {
      // The timeout is this mutation's alone: its prepared state is unknown,
      // so drop it, but the socket is shared by every chat and is only torn
      // down when the transport itself stops answering.
      prepared.delete(sessionId);
      await invalidateClientConnectionIfUnresponsive().catch(
        (invalidationError) => {
          console.error(
            "Failed to check the ACP connection after a timed-out request:",
            invalidationError,
          );
        },
      );
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function serializeSessionMutation<T>(
  sessionId: string,
  mutation: (turn: SessionMutationTurn) => Promise<T>,
  bounded = true,
): Promise<T> {
  let queue = mutationQueues.get(sessionId);
  if (!queue) {
    queue = { latestSequence: 0, tail: Promise.resolve() };
    mutationQueues.set(sessionId, queue);
  }

  const sequence = nextMutationSequence++;
  queue.latestSequence = sequence;
  let abandoned = false;
  const execute = () =>
    mutation({
      isLatest: () => queue?.latestSequence === sequence,
      isAbandoned: () => abandoned,
    });
  const result = queue.tail.then(() =>
    bounded
      ? runBoundedSessionMutation(sessionId, execute(), () => {
          abandoned = true;
        })
      : execute(),
  );
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queue.tail = tail;
  void tail.then(() => {
    if (mutationQueues.get(sessionId)?.tail === tail) {
      mutationQueues.delete(sessionId);
    }
  });
  return result;
}

export async function prepareSession(
  sessionId: string,
  providerId: string,
  workingDir: string,
  options: SessionConfigMutationOptions = {},
): Promise<AcpSessionConfigSnapshots | undefined> {
  return serializeSessionMutation(sessionId, async (turn) =>
    applyPlannedRunSettingsNow(
      sessionId,
      await prepareSessionNow(sessionId, providerId, workingDir, options, turn),
      options,
      turn,
    ),
  );
}

/**
 * A mutation whose bound elapsed keeps running on the socket (which now
 * survives a single timeout) and can resolve long after a newer prepare
 * established the session's provider and model. Its own result must not be
 * written: it describes a state nobody asked for any more. The wire call may
 * still have reached the host, though — and after the newer one, since it
 * answered later — so the current entry's cached model is no longer proof the
 * host is on it. Dropping the cached model costs one `setModel` and is what
 * keeps `applySessionModelNow` from skipping an apply the host never got.
 */
function discardSupersededPreparation(
  sessionId: string,
  providerId: string,
  modelId: string | undefined,
): void {
  const current = prepared.get(sessionId);
  const currentSelection = current?.executionSelection;
  logReasoningEffortInfo("session mutation result discarded after timeout", {
    sessionId: shortLogId(sessionId),
    appliedProviderId: providerId,
    appliedModelId: modelId ?? null,
    currentProviderId: currentSelection?.providerId ?? null,
    currentModelId: currentSelection?.modelId ?? null,
  });
  if (!current || !currentSelection) return;
  if (
    currentSelection.providerId === providerId &&
    currentSelection.modelId === modelId
  ) {
    return;
  }
  replaceExecutionSelection(current, currentSelection.providerId);
}

async function prepareSessionNow(
  sessionId: string,
  providerId: string,
  workingDir: string,
  options: SessionConfigMutationOptions,
  turn: SessionMutationTurn,
): Promise<AcpSessionConfigSnapshots | undefined> {
  const sid = sessionId.slice(0, 8);
  const existing = prepared.get(sessionId);
  if (existing) {
    const tReuse = performance.now();
    let changed = false;
    let snapshots: AcpSessionConfigSnapshots | undefined;
    const existingProviderId = existing.executionSelection?.providerId;
    logReasoningEffortInfo("prepareSession reuse", {
      sessionId: shortLogId(sessionId),
      existingProviderId: existingProviderId ?? null,
      requestedProviderId: providerId,
      providerChanged: existingProviderId !== providerId,
      workingDirChanged: existing.workingDir !== workingDir,
      cachedModelId: existing.executionSelection?.modelId ?? null,
    });
    if (existing.workingDir !== workingDir) {
      await acpApi.updateWorkingDir(sessionId, workingDir);
      if (!turn.isAbandoned()) {
        existing.workingDir = workingDir;
      }
      changed = true;
    }
    if (existingProviderId !== providerId || options.forceConfigRefresh) {
      const tProv = performance.now();
      try {
        snapshots = await acpApi.setProvider(sessionId, providerId, {
          requestId: options.requestId,
        });
      } catch (error) {
        // Goose can apply the provider and then fail while building the
        // response snapshot. The complete backend pair is unknown until the
        // UI selection is prepared again.
        existing.executionSelection = undefined;
        throw error;
      }
      perfLog(
        `[perf:prepare] ${sid} reuse setProvider(${providerId}) in ${(performance.now() - tProv).toFixed(1)}ms`,
      );
      const reusedModelId = normalizeConcreteModelId(snapshots?.model?.modelId);
      if (turn.isAbandoned()) {
        discardSupersededPreparation(sessionId, providerId, reusedModelId);
        return snapshots;
      }
      replaceExecutionSelection(existing, providerId, reusedModelId);
      changed = true;
    }
    perfLog(
      `[perf:prepare] ${sid} reuse existing session (updates=${changed}) in ${(performance.now() - tReuse).toFixed(1)}ms`,
    );
    return snapshots;
  }

  const tLoad = performance.now();
  logReasoningEffortInfo("prepareSession load", {
    sessionId: shortLogId(sessionId),
    providerId,
  });
  await acpApi.loadSession(sessionId, workingDir);
  perfLog(
    `[perf:prepare] ${sid} registry loadSession ok in ${(performance.now() - tLoad).toFixed(1)}ms`,
  );

  const tProv = performance.now();
  const snapshots = await acpApi.setProvider(sessionId, providerId, {
    requestId: options.requestId,
  });
  perfLog(
    `[perf:prepare] ${sid} registry setProvider(${providerId}) in ${(performance.now() - tProv).toFixed(1)}ms`,
  );

  const acknowledgedModelId = normalizeConcreteModelId(
    snapshots?.model?.modelId,
  );
  if (turn.isAbandoned()) {
    discardSupersededPreparation(sessionId, providerId, acknowledgedModelId);
    return snapshots;
  }
  const entry = {
    workingDir,
    executionSelection: {
      providerId,
      ...(acknowledgedModelId ? { modelId: acknowledgedModelId } : {}),
    },
  };
  prepared.set(sessionId, entry);

  return snapshots;
}

/**
 * Apply a model to a session, skipping the wire call when this window already
 * applied the same model.
 */
export async function applySessionModel(
  sessionId: string,
  modelId: string,
  options: SessionConfigMutationOptions = {},
): Promise<AcpSessionConfigSnapshots | undefined> {
  const concreteModelId = normalizeConcreteModelId(modelId);
  if (!concreteModelId) {
    throw new Error(`Invalid model id: ${modelId}`);
  }
  return serializeSessionMutation(sessionId, (turn) =>
    applySessionModelNow(sessionId, concreteModelId, options, turn),
  );
}

async function applySessionModelNow(
  sessionId: string,
  modelId: string,
  options: SessionConfigMutationOptions,
  turn: SessionMutationTurn,
): Promise<AcpSessionConfigSnapshots | undefined> {
  const sid = sessionId.slice(0, 8);
  const entry = prepared.get(sessionId);
  const executionSelection = entry?.executionSelection;
  if (!entry || !executionSelection) {
    throw new Error(
      "Session not prepared. Prepare the provider before its model.",
    );
  }
  // Identity, not string equality. Effort is its own channel now, so two ids
  // that name the same model — a legacy `base[effort]` and its base — are the
  // same selection, and re-sending one buys a round trip and nothing else.
  // Until the host stops folding, the acknowledged id may also be the folded
  // form of a base request; that is the same model too.
  if (
    sameModelIdentity(executionSelection.modelId, modelId) &&
    !options.forceConfigRefresh
  ) {
    logReasoningEffortInfo("applySessionModel skipped unchanged", {
      sessionId: shortLogId(sessionId),
      modelId,
      providerId: executionSelection.providerId,
    });
    perfLog(`[perf:prepare] ${sid} skip setModel(${modelId}) — unchanged`);
    return;
  }

  let snapshots: AcpSessionConfigSnapshots | undefined;
  try {
    logReasoningEffortInfo("applySessionModel start", {
      sessionId: shortLogId(sessionId),
      modelId,
      providerId: executionSelection.providerId,
    });
    snapshots = await acpApi.setModel(sessionId, modelId, {
      providerId: executionSelection.providerId,
      requestId: options.requestId,
    });
  } catch (error) {
    // Drop the cached value so the next attempt retries over the wire.
    replaceExecutionSelection(entry, executionSelection.providerId);
    throw error;
  }

  const acknowledgedModelId = snapshots?.model
    ? normalizeConcreteModelId(snapshots.model.modelId)
    : modelId;
  if (turn.isAbandoned()) {
    discardSupersededPreparation(
      sessionId,
      executionSelection.providerId,
      acknowledgedModelId,
    );
    return snapshots;
  }
  replaceExecutionSelection(
    entry,
    executionSelection.providerId,
    acknowledgedModelId,
  );
  // A bridge may answer with the model written either way round — the base id
  // for a folded request, or a folded id for a base one — while naming the
  // same model. Only a different model is a refusal.
  if (!sameModelIdentity(acknowledgedModelId, modelId)) {
    throw new Error(
      `ACP acknowledged model ${acknowledgedModelId ?? "<none>"} instead of requested model ${modelId}`,
    );
  }
  logReasoningEffortInfo("applySessionModel complete", {
    sessionId: shortLogId(sessionId),
    modelId,
    providerId: executionSelection.providerId,
    hasReasoningEffortSnapshot: Boolean(snapshots?.reasoningEffort),
  });
  return snapshots;
}

export async function configureSession(
  sessionId: string,
  providerId: string,
  workingDir: string,
  modelId?: string,
  options: SessionConfigMutationOptions = {},
): Promise<AcpSessionConfigSnapshots | undefined> {
  const concreteModelId = normalizeConcreteModelId(modelId);
  if (modelId && !concreteModelId) {
    throw new Error(`Invalid model id: ${modelId}`);
  }
  return serializeSessionMutation(sessionId, async (turn) => {
    const providerBefore =
      prepared.get(sessionId)?.executionSelection?.providerId;
    let snapshots = await prepareSessionNow(
      sessionId,
      providerId,
      workingDir,
      concreteModelId ? {} : options,
      turn,
    );
    if (concreteModelId) {
      try {
        snapshots =
          (await applySessionModelNow(
            sessionId,
            concreteModelId,
            options,
            turn,
          )) ?? snapshots;
      } catch (error) {
        const entry = prepared.get(sessionId);
        // An abandoned turn answers long after its caller was rejected: the
        // entry it would clear is whatever a later mutation established.
        if (
          !turn.isAbandoned() &&
          providerBefore !== undefined &&
          providerBefore !== providerId &&
          entry?.executionSelection?.providerId === providerId
        ) {
          // The session did move: only the model it was meant to arrive on
          // failed. What the move itself answered was stamped with no request
          // id and most likely dropped as divergent from the selection in
          // flight, so nobody holds the model the provider put the chat on.
          // Forget the pair, so that whoever settles the chat on this provider
          // asks the host again instead of being told "already there".
          entry.executionSelection = undefined;
          throw new ModelFailedAfterProviderMoveError(providerId, error);
        }
        throw error;
      }
    }
    return applyPlannedRunSettingsNow(sessionId, snapshots, options, turn);
  });
}

/**
 * One mutation moved a session to another provider and then failed to put it
 * on the model it was asked for. The two halves are different news: the first
 * happened, and a caller that treats the whole thing as "the switch failed"
 * takes the session back off a provider that accepted it — which, with a model
 * preference the provider has since retired, is every time.
 *
 * Reads like the error it wraps (`message`, `data`), so whatever classifies
 * errors by their text or payload sees the original.
 */
export class ModelFailedAfterProviderMoveError extends Error {
  readonly data: unknown;

  constructor(
    readonly providerId: string,
    readonly cause: unknown,
  ) {
    super(
      cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : typeof cause === "object" &&
              cause !== null &&
              "message" in cause &&
              typeof cause.message === "string"
            ? cause.message
            : "The model could not be applied after the provider changed",
    );
    this.name = "ModelFailedAfterProviderMoveError";
    this.data =
      typeof cause === "object" && cause !== null && "data" in cause
        ? cause.data
        : undefined;
  }
}

/**
 * The last two steps of a selection: effort, then fast, decided from the
 * answer the provider/model steps just produced and written inside the same
 * mutation. A prompt, a load or another selection therefore cannot land between
 * the model and the effort it is meant to run at — which is exactly the window
 * in which a claude session that passed through Haiku would run at "default".
 */
async function applyPlannedRunSettingsNow(
  sessionId: string,
  snapshots: AcpSessionConfigSnapshots | undefined,
  options: SessionConfigMutationOptions,
  turn: SessionMutationTurn,
): Promise<AcpSessionConfigSnapshots | undefined> {
  if (!options.planRunSettings || turn.isAbandoned()) {
    return snapshots;
  }
  const write = options.planRunSettings(snapshots);
  if (!write?.effort && !write?.fast) {
    return snapshots;
  }
  const selection = prepared.get(sessionId)?.executionSelection;
  try {
    const answer = await applySessionRunSettingsNow(sessionId, write, {
      ...(selection?.providerId ? { providerId: selection.providerId } : {}),
      ...(selection?.modelId ? { modelId: selection.modelId } : {}),
      ...(options.requestId ? { requestId: options.requestId } : {}),
    });
    return mergeRunSettingsAnswer(snapshots, answer);
  } catch (error) {
    // A model that will not take an effort or a fast toggle still runs, so the
    // selection it belongs to must not fail over it. The reconciler that runs
    // once the selection commits reads the unchanged menus and says what is
    // running instead.
    console.error("Failed to apply run settings after the model:", error);
    return snapshots;
  }
}

/**
 * The run-settings answer is the newest full option list, so it replaces the
 * model's. A downgrade the model write reported survives an answer that says
 * nothing about one: the effort write that follows a clamp is usually not
 * made at all, and a fast write's answer is not a verdict on the effort.
 */
function mergeRunSettingsAnswer(
  before: AcpSessionConfigSnapshots | undefined,
  answer: AcpSessionConfigSnapshots | undefined,
): AcpSessionConfigSnapshots | undefined {
  if (!answer) {
    return before;
  }
  const substitutions = answer.substitutions ?? before?.substitutions;
  return substitutions ? { ...answer, substitutions } : answer;
}

export function applySessionConfigOption(
  sessionId: string,
  configId: string,
  value: string | boolean,
  context: Omit<AcpSessionConfigSnapshotContext, "origin"> = {},
): Promise<AcpSessionConfigSnapshots> {
  return serializeSessionMutation(sessionId, () =>
    acpApi.setSessionConfigOption(sessionId, configId, value, context),
  );
}

/**
 * Apply the run settings a model change left to be re-applied, in order:
 * effort, then fast. It runs in the same per-session mutation queue as the
 * model apply, so model → effort → fast reach the bridge as one ordered
 * sequence rather than three racing writes.
 *
 * The caller decides WHAT to write — only a value the current model advertises
 * ever gets this far (see `runSettingsReconciler`). This function decides
 * whether the write is still needed: a value this window already wrote for the
 * current model is skipped, which is what keeps a duplicate
 * `config_option_update` (grok emits one for a client-initiated set; claude and
 * codex do not) from writing twice, and what stops a bridge that answers with a
 * clamped value from being written to in a loop.
 */
export function applySessionRunSettings(
  sessionId: string,
  write: AcpSessionRunSettingsWrite,
  context: Omit<AcpSessionConfigSnapshotContext, "origin"> = {},
): Promise<AcpSessionConfigSnapshots | undefined> {
  return serializeSessionMutation(sessionId, () =>
    applySessionRunSettingsNow(sessionId, write, context),
  );
}

async function applySessionRunSettingsNow(
  sessionId: string,
  write: AcpSessionRunSettingsWrite,
  context: Omit<AcpSessionConfigSnapshotContext, "origin">,
): Promise<AcpSessionConfigSnapshots | undefined> {
  let snapshots: AcpSessionConfigSnapshots | undefined;
  const selection = prepared.get(sessionId)?.executionSelection;

  if (write.effort && selection?.effort !== write.effort.value) {
    snapshots = await acpApi.setSessionConfigOption(
      sessionId,
      write.effort.configId,
      write.effort.value,
      { ...context, reasoningEffortValue: write.effort.value },
    );
    // What was REQUESTED, not what came back: a bridge that clamps the value
    // must not be asked for the same thing again on the next snapshot.
    rememberRunSetting(sessionId, selection, { effort: write.effort.value });
  }

  if (write.fast && selection?.fast !== write.fast.value) {
    snapshots =
      (await acpApi.setSessionConfigOption(
        sessionId,
        write.fast.configId,
        write.fast.kind === "boolean"
          ? write.fast.value
          : write.fast.value
            ? "on"
            : "off",
        context,
      )) ?? snapshots;
    rememberRunSetting(sessionId, selection, { fast: write.fast.value });
  }

  return snapshots;
}

// The acknowledged pair may have been replaced while the write was in flight
// (a model change landing in between), in which case this value describes a
// model that is no longer current and is dropped.
function rememberRunSetting(
  sessionId: string,
  selectionAtRequest: AcpSessionExecutionSelection | undefined,
  applied: { effort?: string; fast?: boolean },
): void {
  const selection = prepared.get(sessionId)?.executionSelection;
  if (!selection || selection !== selectionAtRequest) {
    return;
  }
  Object.assign(selection, applied);
}

export function isSessionPrepared(sessionId: string): boolean {
  return Boolean(prepared.get(sessionId)?.executionSelection);
}

/** Provider id the session is currently prepared against, if known. */
export function getPreparedProviderId(sessionId: string): string | undefined {
  return prepared.get(sessionId)?.executionSelection?.providerId;
}

/** Return the complete backend execution selection observed by this window. */
export function requireSessionInvocationSelection(
  sessionId: string,
): AcpSessionExecutionSelection & { modelId: string } {
  const selection = prepared.get(sessionId)?.executionSelection;
  if (!selection?.providerId || !selection.modelId) {
    throw new Error(
      "Session requires a configured provider and model before prompting. Re-prepare the session after completing provider setup.",
    );
  }
  return { ...selection, modelId: selection.modelId };
}

/** Run prompt setup and transport without allowing session config to interleave. */
export function runPreparedSessionPrompt<T>(
  sessionId: string,
  prompt: (providerId: string) => Promise<T>,
): Promise<T> {
  return serializeSessionMutation(
    sessionId,
    () => prompt(requireSessionInvocationSelection(sessionId).providerId),
    false,
  );
}

export async function loadSession(
  sessionId: string,
  workingDir: string,
): Promise<{
  response: Awaited<ReturnType<typeof acpApi.loadSession>>;
  isCurrent: boolean;
  executionSelection?: AcpSessionExecutionSelection;
}> {
  return serializeSessionMutation(
    sessionId,
    async (turn) => {
      const response = await acpApi.loadSession(sessionId, workingDir);
      const isCurrentResult = turn.isLatest();
      const executionSnapshot = readSessionExecutionConfigSnapshot(response);
      prepared.set(sessionId, {
        workingDir,
        executionSelection: executionSnapshot ?? undefined,
      });
      return {
        response,
        isCurrent: isCurrentResult,
        executionSelection: executionSnapshot ?? undefined,
      };
    },
    false,
  );
}

export function registerPreparedSession(
  sessionId: string,
  providerId: string,
  workingDir: string,
  modelId?: string,
): () => void {
  const previousEntry = clonePreparedSession(prepared.get(sessionId));
  const acknowledgedModelId = normalizeConcreteModelId(modelId);
  const entry: PreparedSession = {
    workingDir,
    executionSelection: {
      providerId,
      ...(acknowledgedModelId ? { modelId: acknowledgedModelId } : {}),
    },
  };

  prepared.set(sessionId, entry);
  logReasoningEffortInfo("registerPreparedSession", {
    sessionId: shortLogId(sessionId),
    providerId,
    hadPreviousEntry: Boolean(previousEntry),
    previousProviderId: previousEntry?.executionSelection?.providerId ?? null,
    previousModelId: previousEntry?.executionSelection?.modelId ?? null,
  });

  return () => {
    if (prepared.get(sessionId) !== entry) {
      return;
    }
    prepared.delete(sessionId);
    if (previousEntry) {
      prepared.set(sessionId, previousEntry);
    }
  };
}
