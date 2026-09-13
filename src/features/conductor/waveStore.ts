/**
 * Persisted wave-engine state: the waves in flight and the tombstones that keep
 * a plan message from ever being processed twice.
 *
 * It is a sibling localStorage key rather than an extension of the conductor
 * graph, so wave bookkeeping can be cleared, migrated or dropped without
 * touching the graph the whole UI renders from.
 *
 * Every mutation helper is a pure function over the state object; the module
 * keeps one in-memory copy and writes it through to localStorage.
 */

import { isModelPreferenceClassId } from "@/features/agents/lib/modelRanking";

import {
  CONDUCTOR_WAVES_DOCUMENT,
  conductorDocument,
} from "./conductorDocuments";
import type { WaveStepBudget } from "./distillWave";
import { notePersistFailure } from "./persistHealth";
import {
  WAVE_PHASES,
  WAVE_STEP_PHASES,
  type WavePhase,
  type WaveState,
  type WaveStepPhase,
  type WaveStepState,
  type WaveVerdictIssue,
} from "./waveEngine";
import type { CompletedWaveStepReport } from "./wavePrompts";
import type { StructuredReport } from "./types";

export const CONDUCTOR_WAVES_STORAGE_KEY = "distill:conductor-waves";

/**
 * Cap on remembered plan messages. Tombstones are tiny and only grow one entry
 * per conductor plan, but the key must not grow without bound across years of
 * use; the oldest entries fall off first.
 */
export const MAX_WAVE_TOMBSTONES = 500;

/** What happened to a plan message the engine has already looked at. */
export type WaveTombstoneOutcome =
  /** The plan was admitted and its wave was created. */
  | "spawned"
  /** The fence was invalid (or refused by the engine); nothing was spawned. */
  | "rejected";

export interface WaveTombstone {
  planMessageId: string;
  conductorSessionId: string;
  outcome: WaveTombstoneOutcome;
  at: number;
}

/**
 * Current schema version.
 *
 * v1 (2a) held only running waves. v2 (3a) adds the closed-loop fields — the
 * lifecycle phase, the root request identity, the revision count, the digest
 * attempt and the carried reports of a revision. v1 payloads are migrated in
 * place rather than discarded: a wave persisted mid-run resumes as `running`
 * with a fresh root identity, which is exactly what it was.
 */
export const WAVE_ENGINE_STATE_VERSION = 2;

export interface WaveEngineState {
  version: 2;
  /**
   * Waves the engine still has something to do with. Accepted and superseded
   * waves are dropped (the tombstone remains); waves parked on `needsOperator`
   * are kept, because they back the manual retry.
   */
  waves: WaveState[];
  tombstones: WaveTombstone[];
}

export function emptyWaveEngineState(): WaveEngineState {
  return { version: WAVE_ENGINE_STATE_VERSION, waves: [], tombstones: [] };
}

/**
 * Both guards are derived from the engine's own phase arrays rather than
 * re-listing the members here. A hand-written second schema is what dropped
 * every wave holding a `"failed"` step on reload — the union grew, the guard
 * did not, and a wave that could not be parsed took its live children with it.
 */
function isPhase(value: unknown): value is WaveStepPhase {
  return (WAVE_STEP_PHASES as readonly unknown[]).includes(value);
}

function parseStep(value: unknown): WaveStepState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<WaveStepState>;
  if (
    typeof raw.stepIndex !== "number" ||
    !Number.isInteger(raw.stepIndex) ||
    raw.stepIndex < 0 ||
    typeof raw.role !== "string" ||
    !raw.role ||
    typeof raw.subtask !== "string" ||
    !raw.subtask ||
    !isPhase(raw.phase)
  ) {
    return null;
  }
  const access =
    raw.access === "all"
      ? ("all" as const)
      : Array.isArray(raw.access) && raw.access.length === 0
        ? ([] as const)
        : null;
  if (access === null) return null;
  const budget = parseStepBudget(raw.budget);
  return {
    stepIndex: raw.stepIndex,
    role: raw.role,
    subtask: raw.subtask,
    access,
    ...(typeof raw.label === "string" && raw.label ? { label: raw.label } : {}),
    ...(typeof raw.model === "string" && raw.model ? { model: raw.model } : {}),
    ...(budget ? { budget } : {}),
    ...(isModelPreferenceClassId(raw.modelClass)
      ? { modelClass: raw.modelClass }
      : {}),
    phase: raw.phase,
    ...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.runId === "string" ? { runId: raw.runId } : {}),
    ...(raw.reportDegraded === true ? { reportDegraded: true } : {}),
    ...(raw.reportVerified === true ? { reportVerified: true } : {}),
    ...(raw.verificationFailed === true ? { verificationFailed: true } : {}),
    ...(typeof raw.verificationDetail === "string" && raw.verificationDetail
      ? { verificationDetail: raw.verificationDetail }
      : {}),
  };
}

/**
 * A persisted step budget (P49), keeping only the readable ceilings.
 *
 * Same salvage discipline as the rest of the record: one junk member drops
 * that member, not the step. A budget with nothing readable left reads as
 * "not set" rather than as an empty object, which the parser refuses too.
 */
function parseStepBudget(value: unknown): WaveStepBudget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const budget: WaveStepBudget = {};
  for (const key of ["usd", "tokens", "minutes"] as const) {
    const amount = raw[key];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      continue;
    }
    budget[key] = amount;
  }
  return Object.keys(budget).length > 0 ? budget : null;
}

function isWavePhase(value: unknown): value is WavePhase {
  return (WAVE_PHASES as readonly unknown[]).includes(value);
}

/** The Q5 retry note: why the last answer to this wave's digest was unusable. */
function parseVerdictIssue(value: unknown): WaveVerdictIssue | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<WaveVerdictIssue>;
  if (raw.reason !== "missing" && raw.reason !== "invalid") return null;
  return {
    reason: raw.reason,
    ...(typeof raw.detail === "string" && raw.detail
      ? { detail: raw.detail }
      : {}),
  };
}

function parseStructuredReport(value: unknown): StructuredReport | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<StructuredReport>;
  if (typeof raw.runId !== "string" || typeof raw.summary !== "string") {
    return null;
  }
  if (
    raw.status !== "completed" &&
    raw.status !== "failed" &&
    raw.status !== "cancelled" &&
    raw.status !== "blocked"
  ) {
    return null;
  }
  const strings = (input: unknown): string[] =>
    Array.isArray(input)
      ? input.filter((item): item is string => typeof item === "string")
      : [];
  return {
    runId: raw.runId,
    status: raw.status,
    ...(typeof raw.reason === "string" && raw.reason
      ? { reason: raw.reason }
      : {}),
    summary: raw.summary,
    decisions: strings(raw.decisions),
    artifacts: Array.isArray(raw.artifacts)
      ? raw.artifacts.flatMap((item) =>
          item && typeof item === "object" && typeof item.label === "string"
            ? [item]
            : [],
        )
      : [],
    risks: strings(raw.risks),
    needsOperator: raw.needsOperator === true,
    nextSuggestedTask:
      typeof raw.nextSuggestedTask === "string" ? raw.nextSuggestedTask : null,
    ...(raw.publishedToParent ? { publishedToParent: true } : {}),
    ...(raw.operatorIntervened ? { operatorIntervened: true } : {}),
  };
}

/**
 * Carried reports are the Q4 handoff of a revision wave. A carried report that
 * cannot be read is dropped rather than failing the whole wave: losing one
 * entry degrades the handoff, losing the wave would strand live children.
 */
function parseCarriedReports(value: unknown): CompletedWaveStepReport[] {
  if (!Array.isArray(value)) return [];
  const entries: CompletedWaveStepReport[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Partial<CompletedWaveStepReport>;
    const report = parseStructuredReport(raw.report);
    if (
      typeof raw.stepIndex !== "number" ||
      !Number.isInteger(raw.stepIndex) ||
      typeof raw.role !== "string" ||
      typeof raw.subtask !== "string" ||
      !report
    ) {
      continue;
    }
    entries.push({
      stepIndex: raw.stepIndex,
      role: raw.role,
      subtask: raw.subtask,
      report,
      ...(raw.fromPreviousWave ? { fromPreviousWave: true } : {}),
    });
  }
  return entries;
}

function parseWave(value: unknown): WaveState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<WaveState>;
  if (
    typeof raw.waveId !== "string" ||
    !raw.waveId ||
    typeof raw.conductorSessionId !== "string" ||
    !raw.conductorSessionId ||
    typeof raw.planMessageId !== "string" ||
    !raw.planMessageId ||
    !Array.isArray(raw.steps) ||
    raw.steps.length === 0
  ) {
    return null;
  }
  const steps: WaveStepState[] = [];
  for (const step of raw.steps) {
    const parsed = parseStep(step);
    // An unreadable *step* is dropped; the wave is not. Dropping the wave is
    // the most destructive possible response to a parse miss — the tombstone
    // survives, so nothing is ever re-admitted, and the wave's still-running
    // children are orphaned with no digest and no notice. A wave short one
    // step still digests, still asks for a verdict, and is still visible.
    if (!parsed) continue;
    steps.push(parsed);
  }
  // Nothing readable is left: there is no wave to resume.
  if (steps.length === 0) return null;
  const carriedReports = parseCarriedReports(raw.carriedReports);
  const verdictIssue = parseVerdictIssue(raw.verdictIssue);
  return {
    waveId: raw.waveId,
    conductorSessionId: raw.conductorSessionId,
    planMessageId: raw.planMessageId,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    steps: steps.sort((left, right) => left.stepIndex - right.stepIndex),
    // v1 → v2 migration, applied per wave rather than in a separate pass: a
    // wave persisted before 3a was by construction still running, served its
    // own plan message as the root request, and had spent no revisions.
    phase: isWavePhase(raw.phase) ? raw.phase : "running",
    rootRequestId:
      typeof raw.rootRequestId === "string" && raw.rootRequestId
        ? raw.rootRequestId
        : raw.planMessageId,
    revisionCount:
      typeof raw.revisionCount === "number" &&
      Number.isInteger(raw.revisionCount) &&
      raw.revisionCount >= 0
        ? raw.revisionCount
        : 0,
    digestAttempt:
      typeof raw.digestAttempt === "number" &&
      Number.isInteger(raw.digestAttempt) &&
      raw.digestAttempt >= 0
        ? raw.digestAttempt
        : 0,
    ...(carriedReports.length > 0 ? { carriedReports } : {}),
    ...(verdictIssue ? { verdictIssue } : {}),
    ...(isDirtyCount(raw.gitDirtyAtAdmission)
      ? { gitDirtyAtAdmission: raw.gitDirtyAtAdmission }
      : {}),
    ...(isDirtyCount(raw.gitDirtyAtDigest)
      ? { gitDirtyAtDigest: raw.gitDirtyAtDigest }
      : {}),
    ...(raw.gitDigestProbed === true ? { gitDigestProbed: true } : {}),
    ...(isDirtyCount(raw.checkedArtifacts)
      ? { checkedArtifacts: raw.checkedArtifacts }
      : {}),
    ...(parseMissingArtifacts(raw.missingArtifacts).length > 0
      ? { missingArtifacts: parseMissingArtifacts(raw.missingArtifacts) }
      : {}),
    ...(raw.artifactsProbed === true ? { artifactsProbed: true } : {}),
    ...(typeof raw.lastProgressAt === "number" && raw.lastProgressAt > 0
      ? { lastProgressAt: raw.lastProgressAt }
      : {}),
    ...(typeof raw.stallCount === "number" &&
    Number.isInteger(raw.stallCount) &&
    raw.stallCount > 0
      ? { stallCount: raw.stallCount }
      : {}),
    ...(raw.stalled === true ? { stalled: true } : {}),
  };
}

/**
 * The E3b paths a persisted wave was carrying, keeping only the readable ones.
 *
 * Same discipline as every other salvage in this module: a wave with one
 * unreadable entry is still a wave, and dropping the whole record over it
 * would orphan its children.
 */
function parseMissingArtifacts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}

/** A salvageable E3a git measurement: a non-negative integer. */
function isDirtyCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseTombstone(value: unknown): WaveTombstone | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<WaveTombstone>;
  if (
    typeof raw.planMessageId !== "string" ||
    !raw.planMessageId ||
    typeof raw.conductorSessionId !== "string" ||
    (raw.outcome !== "spawned" && raw.outcome !== "rejected")
  ) {
    return null;
  }
  return {
    planMessageId: raw.planMessageId,
    conductorSessionId: raw.conductorSessionId,
    outcome: raw.outcome,
    at: typeof raw.at === "number" ? raw.at : 0,
  };
}

/**
 * Strict parse of whatever the storage key holds. Never throws.
 *
 * There is deliberately no version gate: wiping on an unknown (future or
 * mangled) version erased the tombstones with the waves, and the same plan
 * message was then admitted again after reload — spawning duplicate children
 * beside the still-running originals (risk №5). Every wave and tombstone is
 * instead validated field by field; entries this build understands survive
 * any version stamp, and only genuinely unreadable ones drop.
 */
export function parseWaveEngineState(value: unknown): WaveEngineState {
  if (!value || typeof value !== "object") return emptyWaveEngineState();
  const raw = value as Omit<Partial<WaveEngineState>, "version"> & {
    version?: unknown;
  };
  const waves: WaveState[] = [];
  for (const wave of Array.isArray(raw.waves) ? raw.waves : []) {
    const parsed = parseWave(wave);
    if (parsed) waves.push(parsed);
  }
  const tombstones: WaveTombstone[] = [];
  for (const tombstone of Array.isArray(raw.tombstones) ? raw.tombstones : []) {
    const parsed = parseTombstone(tombstone);
    if (parsed) tombstones.push(parsed);
  }
  return { version: WAVE_ENGINE_STATE_VERSION, waves, tombstones };
}

export function hasWaveTombstone(
  state: WaveEngineState,
  planMessageId: string,
): boolean {
  return state.tombstones.some(
    (tombstone) => tombstone.planMessageId === planMessageId,
  );
}

/** Adds a tombstone (idempotent per plan message) and trims the oldest. */
export function withWaveTombstone(
  state: WaveEngineState,
  tombstone: WaveTombstone,
): WaveEngineState {
  if (hasWaveTombstone(state, tombstone.planMessageId)) return state;
  const tombstones = [...state.tombstones, tombstone];
  return {
    ...state,
    tombstones:
      tombstones.length > MAX_WAVE_TOMBSTONES
        ? tombstones.slice(tombstones.length - MAX_WAVE_TOMBSTONES)
        : tombstones,
  };
}

export function withWave(
  state: WaveEngineState,
  wave: WaveState,
): WaveEngineState {
  const index = state.waves.findIndex(
    (candidate) => candidate.waveId === wave.waveId,
  );
  if (index < 0) return { ...state, waves: [...state.waves, wave] };
  if (state.waves[index] === wave) return state;
  const waves = [...state.waves];
  waves[index] = wave;
  return { ...state, waves };
}

export function withoutWave(
  state: WaveEngineState,
  waveId: string,
): WaveEngineState {
  const waves = state.waves.filter((wave) => wave.waveId !== waveId);
  return waves.length === state.waves.length ? state : { ...state, waves };
}

/**
 * Drops the waves a conductor has parked on `needsOperator`.
 *
 * Called when that conductor admits a new plan: the new plan is a new root
 * request, so the parked record — and the retry it backs — is stale.
 */
export function withoutParkedWavesFor(
  state: WaveEngineState,
  conductorSessionId: string,
): WaveEngineState {
  const waves = state.waves.filter(
    (wave) =>
      wave.conductorSessionId !== conductorSessionId ||
      wave.phase !== "needsOperator",
  );
  return waves.length === state.waves.length ? state : { ...state, waves };
}

/**
 * Rewrites every reference to a conductor session id that has been promoted
 * from its draft (client) id to its backend id.
 *
 * A conductor chat can be created lazily: the graph node is registered under
 * the draft id, and the wave the conductor's first turn plans is created with
 * that same draft id. When the promotion lands, the graph node is remapped —
 * and a wave still holding the draft id would be deleted by
 * {@link pruneOrphanedWaves} on the very next tick, taking its live children
 * with it. `WaveStepState.sessionId` is deliberately *not* touched: it is
 * re-derived from the graph node on every `advanceWave` pass. Tombstones are
 * matched on `planMessageId`, so their session id is informational only, but
 * it is rewritten too so the record does not lie.
 */
export function withRemappedConductorSessionId(
  state: WaveEngineState,
  fromId: string,
  toId: string,
): WaveEngineState {
  if (!fromId || !toId || fromId === toId) return state;
  let changed = false;
  const waves = state.waves.map((wave) => {
    if (wave.conductorSessionId !== fromId) return wave;
    changed = true;
    return { ...wave, conductorSessionId: toId };
  });
  const tombstones = state.tombstones.map((tombstone) => {
    if (tombstone.conductorSessionId !== fromId) return tombstone;
    changed = true;
    return { ...tombstone, conductorSessionId: toId };
  });
  return changed ? { ...state, waves, tombstones } : state;
}

/**
 * Waves belonging to conductor sessions the graph no longer knows about.
 *
 * `confirmedWaveIds`, when given, limits the prune to waves the caller has
 * already confirmed as orphaned (the runner requires two consecutive orphaned
 * ticks) — an unconfirmed orphan survives so a transient graph gap cannot
 * erase a live wave.
 */
export function pruneOrphanedWaves(
  state: WaveEngineState,
  knownConductorSessionIds: ReadonlySet<string>,
  confirmedWaveIds?: ReadonlySet<string>,
): WaveEngineState {
  const waves = state.waves.filter(
    (wave) =>
      knownConductorSessionIds.has(wave.conductorSessionId) ||
      (confirmedWaveIds !== undefined && !confirmedWaveIds.has(wave.waveId)),
  );
  return waves.length === state.waves.length ? state : { ...state, waves };
}

let cached: WaveEngineState | null = null;

function readStorage(): WaveEngineState {
  if (typeof window === "undefined") return emptyWaveEngineState();
  try {
    const stored = window.localStorage.getItem(CONDUCTOR_WAVES_STORAGE_KEY);
    if (!stored) return emptyWaveEngineState();
    return parseWaveEngineState(JSON.parse(stored));
  } catch {
    return emptyWaveEngineState();
  }
}

const wavesDocument = conductorDocument<WaveEngineState>({
  path: CONDUCTOR_WAVES_DOCUMENT,
  legacyStorageKey: CONDUCTOR_WAVES_STORAGE_KEY,
  scope: "waves",
  parse: parseWaveEngineState,
  serialize: (state) => state,
});

/** The live wave-engine state, hydrated from localStorage on first read. */
export function getWaveEngineState(): WaveEngineState {
  cached ??= readStorage();
  return cached;
}

/**
 * In-process subscribers, notified after every real change.
 *
 * The run journal (P27) is derived from these transitions rather than emitted
 * by the engine, so this is how it sees them. Deliberately not a window
 * event: the wave state is written and read inside one renderer.
 */
const waveStateListeners = new Set<
  (state: WaveEngineState, change: WaveStateChange) => void
>();

/** What kind of change a listener is being told about. */
export interface WaveStateChange {
  /**
   * True when the change is the folder's waves joining memory at startup.
   * Nothing moved: those waves were already in that state before this
   * process began, and a reader that diffs transitions must not report them
   * as newly admitted.
   */
  hydration: boolean;
}

/** Subscribes to wave-state changes. Returns the unsubscribe. */
export function subscribeWaveEngineState(
  listener: (state: WaveEngineState, change: WaveStateChange) => void,
): () => void {
  waveStateListeners.add(listener);
  return () => {
    waveStateListeners.delete(listener);
  };
}

/** Replaces the live state and writes it through. A no-op change is skipped. */
export function setWaveEngineState(
  next: WaveEngineState,
  change: Partial<WaveStateChange> = {},
): void {
  if (cached === next) return;
  cached = next;
  const notice: WaveStateChange = { hydration: change.hydration === true };
  for (const listener of [...waveStateListeners]) {
    try {
      listener(next, notice);
    } catch {
      // A reader that throws must not take the engine's write path with it.
    }
  }
  if (typeof window === "undefined") return;
  if (wavesDocument.active) {
    // Never before the folder has been read. The file is the only copy of
    // every tombstone and every parked wave of previous runs; a write from
    // the near-empty in-memory copy before the read landed — or after it
    // failed — would replace them all. The change is kept in memory and
    // written the moment a read succeeds.
    if (!wavesReadSucceeded) {
      wavesWriteHeld = true;
      return;
    }
    wavesDocument.write(next);
    return;
  }
  try {
    window.localStorage.setItem(
      CONDUCTOR_WAVES_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch (error) {
    // The in-memory copy still drives the run, so the wave finishes — but
    // from here a restart loses it, and P18 is what makes that sayable.
    notePersistFailure("waves", error);
  }
}

/**
 * Folds the folder's waves into the live state (P24).
 *
 * A wave already in memory wins: it is the one this session is driving, and
 * the file is at best a snapshot from before the app started. Everything else
 * the file knows about — the waves of the previous run — is added, which is
 * the whole point of persisting them.
 *
 * Tombstones merge the same way, because a tombstone the file holds and
 * memory does not is exactly the record that stops a restart from re-admitting
 * an old plan as a new root request.
 *
 * Rejects when the folder has a document that could not be read, and leaves
 * the store exactly as it was: not hydrated, writes still held. The caller
 * may try again; when it gives up it says so through
 * {@link markWaveEngineStateHydrationFailed}, so nothing waits forever.
 */
export async function hydrateWaveEngineState(): Promise<void> {
  if (!wavesDocument.active) return;
  const stored = await wavesDocument.read();
  // From here the file is known, so writing over it is safe: the merge
  // below is the first write, and it carries everything the file had.
  wavesReadSucceeded = true;
  if (stored) {
    mergeStoredWaveEngineState(stored);
  } else if (wavesWriteHeld) {
    wavesDocument.write(getWaveEngineState());
  }
  wavesWriteHeld = false;
  markWaveEngineStateHydrated();
}

/**
 * True once the folder's waves have been folded in — or when there is no
 * folder to wait for.
 *
 * The engine must not tick before this. On the desktop the synchronous load
 * finds an empty `localStorage` (the folder is the only copy after the P24
 * migration), so a tick in that window sees no waves and no tombstones: it
 * spends the one-shot "resume orphaned spawns" pass on nothing, and a plan
 * message already admitted in a previous run looks brand new and is admitted
 * again beside the children it already has.
 *
 * False after a failed read too — "the file could not be read" is not "the
 * file was read and held nothing", and the tick must not run on the second
 * story when the first is true.
 */
export function isWaveEngineStateHydrated(): boolean {
  if (wavesHydratedForTests !== null) return wavesHydratedForTests === true;
  return wavesHydration === "hydrated" || !wavesDocument.active;
}

/**
 * True when the caller stopped trying to read the folder's waves. The store
 * is then neither hydrated nor going to be, and the engine stays off for the
 * session rather than running on an empty tombstone list.
 */
export function hasWaveEngineStateHydrationFailed(): boolean {
  if (wavesHydratedForTests !== null) return wavesHydratedForTests === "failed";
  return wavesHydration === "failed";
}

let wavesHydratedForTests: boolean | "failed" | null = null;

/** Where the folder read stands. `pending` until it settles either way. */
let wavesHydration: "pending" | "hydrated" | "failed" = "pending";
/** True once one read succeeded — the write gate, distinct from the phase. */
let wavesReadSucceeded = false;
/** True when a write was refused by the gate and is owed after the read. */
let wavesWriteHeld = false;
const hydrationWaiters = new Set<() => void>();

function releaseHydrationWaiters(): void {
  const waiters = [...hydrationWaiters];
  hydrationWaiters.clear();
  for (const waiter of waiters) {
    try {
      waiter();
    } catch {
      // One waiter that throws must not keep the others waiting.
    }
  }
}

function markWaveEngineStateHydrated(): void {
  wavesHydration = "hydrated";
  releaseHydrationWaiters();
}

/**
 * Records that the folder's waves will not be read this session.
 *
 * Called by the startup hydration after its last retry. The waiters run — a
 * waiter that never runs is an engine that never learns it must stay off —
 * and each one reads {@link isWaveEngineStateHydrated} (still false) and
 * {@link hasWaveEngineStateHydrationFailed} (now true) to decide.
 */
export function markWaveEngineStateHydrationFailed(): void {
  if (wavesHydration === "hydrated") return;
  wavesHydration = "failed";
  releaseHydrationWaiters();
}

/**
 * Calls `callback` once the folder read has settled — hydrated, or given up
 * on — and immediately when it already has. Never parks a caller forever.
 */
export function whenWaveEngineStateHydrated(callback: () => void): void {
  if (isWaveEngineStateHydrated() || hasWaveEngineStateHydrationFailed()) {
    callback();
    return;
  }
  hydrationWaiters.add(callback);
}

function mergeStoredWaveEngineState(stored: WaveEngineState): void {
  const live = getWaveEngineState();
  const liveWaveIds = new Set(live.waves.map((wave) => wave.waveId));
  const liveTombstoneIds = new Set(
    live.tombstones.map((tombstone) => tombstone.planMessageId),
  );
  setWaveEngineState(
    {
      ...stored,
      ...live,
      waves: [
        ...stored.waves.filter((wave) => !liveWaveIds.has(wave.waveId)),
        ...live.waves,
      ],
      tombstones: [
        ...stored.tombstones.filter(
          (tombstone) => !liveTombstoneIds.has(tombstone.planMessageId),
        ),
        ...live.tombstones,
      ],
    },
    { hydration: true },
  );
}

/** Pushes a queued wave write to disk. Shutdown, and tests. */
export function flushWaveEngineWrites(): Promise<void> {
  return wavesDocument.flush();
}

/** Applies a pure update to the live state. */
export function updateWaveEngineState(
  update: (state: WaveEngineState) => WaveEngineState,
): WaveEngineState {
  const next = update(getWaveEngineState());
  setWaveEngineState(next);
  return next;
}

/** Drops the in-memory copy so the next read re-hydrates. Tests only. */
export function resetWaveEngineStateCache(): void {
  cached = null;
}

/**
 * Pins the hydration answer — read, not read, or given up on — or (`null`)
 * returns it to the real one. When pinned to true, parked waiters run.
 * Tests only.
 */
export function setWaveEngineStateHydratedForTests(
  hydrated: boolean | "failed" | null,
): void {
  wavesHydratedForTests = hydrated;
  // Pinning "not read" also forgets a real read, so that returning to the
  // real answer waits for the next hydration.
  if (hydrated === false) wavesHydration = "pending";
  if (hydrated === true) markWaveEngineStateHydrated();
  if (hydrated === "failed") markWaveEngineStateHydrationFailed();
}

/** Forgets every read, held write and waiter. Tests only. */
export function resetWaveEngineStateHydrationForTests(): void {
  wavesHydratedForTests = null;
  wavesHydration = "pending";
  wavesReadSucceeded = false;
  wavesWriteHeld = false;
  hydrationWaiters.clear();
}
