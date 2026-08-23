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

import type { WaveState, WaveStepPhase, WaveStepState } from "./waveEngine";

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

export interface WaveEngineState {
  version: 1;
  /** Waves still running. Finished waves are dropped; the tombstone remains. */
  waves: WaveState[];
  tombstones: WaveTombstone[];
}

export function emptyWaveEngineState(): WaveEngineState {
  return { version: 1, waves: [], tombstones: [] };
}

function isPhase(value: unknown): value is WaveStepPhase {
  return value === "pending" || value === "spawning" || value === "spawned";
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
    phase: raw.phase,
    ...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.runId === "string" ? { runId: raw.runId } : {}),
  };
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
    // A wave with an unreadable step cannot be resumed safely: dropping the
    // whole wave leaves the tombstone in place, so nothing respawns either.
    if (!parsed) return null;
    steps.push(parsed);
  }
  return {
    waveId: raw.waveId,
    conductorSessionId: raw.conductorSessionId,
    planMessageId: raw.planMessageId,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    steps: steps.sort((left, right) => left.stepIndex - right.stepIndex),
  };
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

/** Strict parse of whatever the storage key holds. Never throws. */
export function parseWaveEngineState(value: unknown): WaveEngineState {
  if (!value || typeof value !== "object") return emptyWaveEngineState();
  const raw = value as Partial<WaveEngineState>;
  if (raw.version !== 1) return emptyWaveEngineState();
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
  return { version: 1, waves, tombstones };
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

/** Waves belonging to conductor sessions the graph no longer knows about. */
export function pruneOrphanedWaves(
  state: WaveEngineState,
  knownConductorSessionIds: ReadonlySet<string>,
): WaveEngineState {
  const waves = state.waves.filter((wave) =>
    knownConductorSessionIds.has(wave.conductorSessionId),
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
