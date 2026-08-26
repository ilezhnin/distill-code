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

export const CONDUCTOR_WAVES_STORAGE_KEY = "goose:conductor-waves";

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
  return {
    stepIndex: raw.stepIndex,
    role: raw.role,
    subtask: raw.subtask,
    access,
    ...(typeof raw.label === "string" && raw.label ? { label: raw.label } : {}),
    phase: raw.phase,
    ...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.runId === "string" ? { runId: raw.runId } : {}),
    ...(raw.reportDegraded === true ? { reportDegraded: true } : {}),
  };
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
    raw.status !== "cancelled"
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
  };
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

/** The live wave-engine state, hydrated from localStorage on first read. */
export function getWaveEngineState(): WaveEngineState {
  cached ??= readStorage();
  return cached;
}

/** Replaces the live state and writes it through. A no-op change is skipped. */
export function setWaveEngineState(next: WaveEngineState): void {
  if (cached === next) return;
  cached = next;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CONDUCTOR_WAVES_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch {
    // localStorage may be unavailable; the in-memory copy still drives the run.
  }
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
