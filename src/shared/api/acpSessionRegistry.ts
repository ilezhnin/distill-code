import * as acpApi from "./acpApi";
import { invalidateClientConnection } from "./acpConnection";
import {
  readSessionConfigOptionsSnapshots,
  readSessionExecutionConfigSnapshot,
  type AcpModelConfigSnapshot,
  type AcpSessionConfigSnapshotContext,
  type AcpSessionConfigSnapshots,
} from "./acpSessionConfigSnapshots";
import { perfLog } from "@/shared/lib/perfLog";
import {
  logReasoningEffortInfo,
  shortLogId,
} from "@/shared/lib/reasoningEffortDiagnostics";
import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";

export interface AcpSessionExecutionSelection {
  providerId: string;
  /** Last model this window observed ACP acknowledge successfully. */
  modelId?: string;
}

/**
 * What the live harness said about models the last time it sent a snapshot for
 * this session. Not a cache of Berd's inventories — those are what got the
 * session into trouble in the first place.
 */
interface HarnessModelInventory {
  /** The model the harness reports the session is running on right now. */
  currentModelId: string;
  /** Ids the harness listed. Empty means "it listed none", i.e. unknown. */
  declaredModelIds: readonly string[];
}

interface PreparedSession {
  workingDir: string;
  executionSelection?: AcpSessionExecutionSelection;
  harnessModels?: HarnessModelInventory;
}

interface SessionConfigMutationOptions {
  forceConfigRefresh?: boolean;
  requestId?: string;
}

/**
 * A model pin the live harness does not list among its own models, caught
 * before it is sent.
 *
 * Goose applies the session's model inside `stream()`, on the send path, so an
 * id the ACP agent never advertised is not rejected when it is chosen — it is
 * rejected on every message the operator sends afterwards, as
 * "Failed to set ACP model option: Invalid params".
 * `rejectedModelRecovery` is the net under that; this is the same judgement
 * made one step earlier, while the session is being configured and no message
 * is at stake.
 */
export interface UndeclaredSessionModel {
  sessionId: string;
  providerId: string;
  /** The pin that was refused admission, never sent to the harness. */
  modelId: string;
  /** The model the session is left running on instead. */
  fallbackModelId: string;
  /** What the harness listed, for the operator-facing message and the log. */
  declaredModelIds: readonly string[];
}

/**
 * Lives here rather than in the chat feature for the same reason the config
 * snapshot handlers do: this module is shared and must not import chat code,
 * and the reaction — rewriting the session's target and telling the operator —
 * is chat's to own. Registered once at startup.
 */
type UndeclaredSessionModelHandler = (event: UndeclaredSessionModel) => void;

let undeclaredModelHandler: UndeclaredSessionModelHandler | undefined;

export function setUndeclaredSessionModelHandler(
  handler: UndeclaredSessionModelHandler | undefined,
): void {
  undeclaredModelHandler = handler;
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

/**
 * Record what the harness says about models — but only from snapshots that
 * describe the harness rather than our own request.
 *
 * `session/set_model` responses are excluded on purpose. Goose builds the model
 * option by listing its inventory and prepending whatever the session currently
 * runs when the inventory does not contain it, so the snapshot that comes back
 * from applying a pin always contains that pin. Reading the inventory from
 * there would mean asking the harness whether it accepts a model and hearing
 * back the model we just named — the answer would confirm anything.
 */
function rememberHarnessModels(
  entry: PreparedSession,
  model: AcpModelConfigSnapshot | null | undefined,
): void {
  if (!model) {
    return;
  }
  entry.harnessModels = {
    currentModelId: model.modelId,
    declaredModelIds: model.availableModelIds ?? [],
  };
}

/**
 * Whether the harness listed this id as one of its own.
 *
 * Silence is not refusal. A harness that sent no snapshot, or listed no
 * models at all, has told us nothing, and refusing a pin on that basis would
 * break every agent that does not publish an inventory. Only a non-empty list
 * that omits the id is evidence, and it is first-hand evidence: it came from
 * the process that would receive the id.
 */
function harnessDeclaresModel(
  entry: PreparedSession,
  modelId: string,
): boolean {
  const declared = entry.harnessModels?.declaredModelIds;
  return !declared || declared.length === 0 || declared.includes(modelId);
}

async function runBoundedSessionMutation<T>(
  sessionId: string,
  mutation: Promise<T>,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let didTimeOut = false;
  try {
    return await Promise.race([
      mutation,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          didTimeOut = true;
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
      prepared.delete(sessionId);
      await invalidateClientConnection().catch((invalidationError) => {
        console.error(
          "Failed to invalidate timed-out ACP connection:",
          invalidationError,
        );
      });
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
  mutation: (isLatest: () => boolean) => Promise<T>,
  bounded = true,
): Promise<T> {
  let queue = mutationQueues.get(sessionId);
  if (!queue) {
    queue = { latestSequence: 0, tail: Promise.resolve() };
    mutationQueues.set(sessionId, queue);
  }

  const sequence = nextMutationSequence++;
  queue.latestSequence = sequence;
  const execute = () => mutation(() => queue?.latestSequence === sequence);
  const result = queue.tail.then(() =>
    bounded ? runBoundedSessionMutation(sessionId, execute()) : execute(),
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
  return serializeSessionMutation(sessionId, () =>
    prepareSessionNow(sessionId, providerId, workingDir, options),
  );
}

async function prepareSessionNow(
  sessionId: string,
  providerId: string,
  workingDir: string,
  options: SessionConfigMutationOptions,
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
      existing.workingDir = workingDir;
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
        existing.harnessModels = undefined;
        throw error;
      }
      perfLog(
        `[perf:prepare] ${sid} reuse setProvider(${providerId}) in ${(performance.now() - tProv).toFixed(1)}ms`,
      );
      rememberHarnessModels(existing, snapshots?.model);
      replaceExecutionSelection(
        existing,
        providerId,
        normalizeConcreteModelId(snapshots?.model?.modelId),
      );
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
  const entry: PreparedSession = {
    workingDir,
    executionSelection: {
      providerId,
      ...(acknowledgedModelId ? { modelId: acknowledgedModelId } : {}),
    },
  };
  rememberHarnessModels(entry, snapshots?.model);
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
  return serializeSessionMutation(sessionId, () =>
    applySessionModelNow(sessionId, concreteModelId, options),
  );
}

async function applySessionModelNow(
  sessionId: string,
  modelId: string,
  options: SessionConfigMutationOptions,
): Promise<AcpSessionConfigSnapshots | undefined> {
  const sid = sessionId.slice(0, 8);
  const entry = prepared.get(sessionId);
  const executionSelection = entry?.executionSelection;
  if (!entry || !executionSelection) {
    throw new Error(
      "Session not prepared. Prepare the provider before its model.",
    );
  }
  // Checked before the unchanged-skip, not after: a pin the harness never
  // listed is exactly the value most likely to be sitting in the cache
  // already, and "we sent this last time" is no evidence at all when the
  // harness being talked to is a different process from the one that
  // acknowledged it. Nothing is sent; the session keeps running on the model
  // the harness itself reports, and the operator is told which model was
  // dropped. Refusing here is the whole point — goose does not apply the model
  // until the next prompt, so an id accepted at this stage does not fail now,
  // it fails on every message the operator sends from then on.
  if (!harnessDeclaresModel(entry, modelId)) {
    const fallbackModelId =
      entry.harnessModels?.currentModelId ?? executionSelection.modelId;
    logReasoningEffortInfo("applySessionModel refused undeclared", {
      sessionId: shortLogId(sessionId),
      modelId,
      providerId: executionSelection.providerId,
      fallbackModelId: fallbackModelId ?? null,
      declaredModelIds:
        entry.harnessModels?.declaredModelIds.slice(0, 20).join(",") ?? null,
    });
    replaceExecutionSelection(
      entry,
      executionSelection.providerId,
      fallbackModelId,
    );
    undeclaredModelHandler?.({
      sessionId,
      providerId: executionSelection.providerId,
      modelId,
      fallbackModelId: fallbackModelId ?? "",
      declaredModelIds: entry.harnessModels?.declaredModelIds ?? [],
    });
    return;
  }
  if (executionSelection.modelId === modelId && !options.forceConfigRefresh) {
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
  replaceExecutionSelection(
    entry,
    executionSelection.providerId,
    acknowledgedModelId,
  );
  if (acknowledgedModelId !== modelId) {
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
  return serializeSessionMutation(sessionId, async () => {
    let snapshots = await prepareSessionNow(
      sessionId,
      providerId,
      workingDir,
      concreteModelId ? {} : options,
    );
    if (concreteModelId) {
      snapshots =
        (await applySessionModelNow(sessionId, concreteModelId, options)) ??
        snapshots;
    }
    return snapshots;
  });
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
    async (isLatest) => {
      const response = await acpApi.loadSession(sessionId, workingDir);
      const isCurrentResult = isLatest();
      const executionSnapshot = readSessionExecutionConfigSnapshot(response);
      const entry: PreparedSession = {
        workingDir,
        executionSelection: executionSnapshot ?? undefined,
      };
      rememberHarnessModels(
        entry,
        readSessionConfigOptionsSnapshots(response).model,
      );
      prepared.set(sessionId, entry);
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
  /**
   * The model option from the same snapshot `modelId` was read out of. Session
   * creation prepares the provider through the direct ACP client rather than
   * `prepareSession`, so without this the freshly created session — the one
   * about to be handed a stored model preference — would be the only one with
   * no record of what its harness actually offers.
   */
  harnessModel?: AcpModelConfigSnapshot | null,
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
  rememberHarnessModels(entry, harnessModel);

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
