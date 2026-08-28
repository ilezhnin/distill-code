/**
 * Wave telemetry: what the closed loop actually did, kept after the loop is
 * gone.
 *
 * The audit's point was that every open D3/D4 question — how often a request
 * becomes a wave at all, how many steps waves really use, how often verdicts
 * accept, how often revisions happen — was answerable from data the app
 * already had in its hands and threw away: waves are deleted from the engine
 * store the moment they retire, and the planless-turn denominator lived only
 * in a process-local Set. This module is where those facts survive.
 *
 * Design constraints, in order:
 * - **Never load-bearing.** Telemetry is written from inside the engine's
 *   close paths; a telemetry bug must not be able to break a wave. Every
 *   effectful entry point swallows its own failures.
 * - **Bounded by construction.** Records are capped and the counters are
 *   plain integers. This store must never become the unbounded growth it was
 *   built alongside the graph-store bound to prevent.
 * - **Own storage key.** The graph store persists on every status patch — a
 *   hot path. Telemetry appends on wave close — a cold one. Sharing a
 *   payload would re-serialize history on every patch for nothing.
 *
 * One wave can close more than once: `needsOperator` is re-armable (Q5 retry)
 * and a re-armed wave closes again with its real outcome. Records therefore
 * upsert by `waveId` — the last close is the wave's true end, and "how many
 * waves" stays countable.
 */

import { useSyncExternalStore } from "react";

import { getUsageLedger } from "@/features/stats/lib/usageLedger";

import {
  WAVE_TELEMETRY_DOCUMENT,
  conductorDocument,
} from "./conductorDocuments";
import { notePersistFailure } from "./persistHealth";

import { useConductorGraphStore } from "./conductorGraphStore";
import type { RunStatus, SessionNode } from "./types";
import type { WaveState } from "./waveEngine";
import type { WaveClosureReason } from "./waveVerdict";

export const WAVE_TELEMETRY_STORAGE_KEY = "goose:wave-telemetry";

/**
 * Enough history for every rate the audit asked about, small enough that the
 * payload stays a few tens of kilobytes.
 */
export const MAX_WAVE_TELEMETRY_RECORDS = 200;

/** How a wave left the live loop. */
export type WaveTelemetryOutcome =
  | "accepted"
  | "revised"
  | "needs-operator"
  | "pruned";

export interface WaveStepTelemetry {
  stepIndex: number;
  role: string;
  access: "all" | "none";
  /**
   * The step's terminal run status, or `never-ran` when no child ever
   * registered (spawn failed or the wave closed first). Recorded from the
   * graph node at close time, so a step stopped mid-run records `cancelled`.
   */
  outcome: RunStatus | "never-ran";
  /** True when the step went terminal on the "result unknown" stub (5b). */
  reportDegraded: boolean;
  /**
   * The harness and model this step actually ran on.
   *
   * Recorded because "which model does which kind of step well here" is a
   * question about this installation that only this installation can answer,
   * and answering it from measurements is the one sanctioned alternative to
   * reputational priors about models (P39). Absent for a step that never
   * spawned, which is itself the fact worth keeping.
   */
  harnessId?: string;
  modelId?: string;
  /** Child registration time — the spawn's completion. */
  startedAt?: number;
  /** First transition into a terminal run status. */
  finishedAt?: number;
  durationMs?: number;
  /** The child session's lifetime token total, from the usage ledger. */
  totalTokens?: number;
  /**
   * The child session's estimated cost, from the same ledger row. Absent when
   * the provider gave no price — which is a different fact from "free", so
   * the reader must keep them apart rather than summing a missing price as 0.
   */
  costUsd?: number;
}

export interface WaveTelemetryRecord {
  waveId: string;
  conductorSessionId: string;
  /** The harness and model the conductor itself was on when it planned. */
  conductorHarnessId?: string;
  conductorModelId?: string;
  rootRequestId: string;
  /** 0 on a first wave, n on the n-th revision of its root request. */
  revisionIndex: number;
  createdAt: number;
  closedAt: number;
  durationMs: number;
  outcome: WaveTelemetryOutcome;
  closureReason?: WaveClosureReason;
  /** Digest attempts spent (Q5 retries included) at close time. */
  digestAttempt: number;
  stepCount: number;
  degradedStepCount: number;
  /** E3a measurements, when the probes landed. */
  gitDirtyAtAdmission?: number;
  gitDirtyAtDigest?: number;
  /** Sum of the steps' token totals; absent when no step had one. */
  totalTokens?: number;
  /** Sum of the steps' costs; absent when no step had a priced provider. */
  costUsd?: number;
  steps: WaveStepTelemetry[];
}

/**
 * The denominators. `planlessTurns` is every settled conductor turn that
 * carried no plan — direct answers, mostly; verdict turns are tombstoned
 * before the detector sees them, poke summaries are not distinguishable and
 * count as answers. `admittedWaves` counts every wave that started, root and
 * revision alike (records carry `revisionIndex` for splitting them).
 * `rejectedPlans` are parser/shape refusals; `concurrentRefusals` are valid
 * plans refused because a wave was already live (§4.1).
 */
export interface WaveTelemetryCounters {
  planlessTurns: number;
  admittedWaves: number;
  rejectedPlans: number;
  concurrentRefusals: number;
}

export interface WaveTelemetryState {
  records: WaveTelemetryRecord[];
  counters: WaveTelemetryCounters;
  /**
   * Newest counted planless message `created` per conductor. The scanned-set
   * that guards re-counting is process-local, so a restart re-scans every
   * hydrated transcript; this high-water mark is what keeps those re-scans
   * from counting the same turns again.
   */
  planlessHighWater: Record<string, number>;
}

export function emptyWaveTelemetryState(): WaveTelemetryState {
  return {
    records: [],
    counters: {
      planlessTurns: 0,
      admittedWaves: 0,
      rejectedPlans: 0,
      concurrentRefusals: 0,
    },
    planlessHighWater: {},
  };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFiniteTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A salvageable money amount: finite and not negative. Not an integer. */
function isMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const OUTCOMES: readonly WaveTelemetryOutcome[] = [
  "accepted",
  "revised",
  "needs-operator",
  "pruned",
];

function parseStep(value: unknown): WaveStepTelemetry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<WaveStepTelemetry>;
  if (!isCount(raw.stepIndex) || typeof raw.role !== "string") return null;
  return {
    stepIndex: raw.stepIndex,
    role: raw.role,
    access: raw.access === "all" ? "all" : "none",
    outcome: typeof raw.outcome === "string" ? raw.outcome : "never-ran",
    reportDegraded: raw.reportDegraded === true,
    ...(typeof raw.harnessId === "string" && raw.harnessId
      ? { harnessId: raw.harnessId }
      : {}),
    ...(typeof raw.modelId === "string" && raw.modelId
      ? { modelId: raw.modelId }
      : {}),
    ...(isFiniteTime(raw.startedAt) ? { startedAt: raw.startedAt } : {}),
    ...(isFiniteTime(raw.finishedAt) ? { finishedAt: raw.finishedAt } : {}),
    ...(isCount(raw.durationMs) ? { durationMs: raw.durationMs } : {}),
    ...(isCount(raw.totalTokens) ? { totalTokens: raw.totalTokens } : {}),
    ...(isMoney(raw.costUsd) ? { costUsd: raw.costUsd } : {}),
  };
}

function parseRecord(value: unknown): WaveTelemetryRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<WaveTelemetryRecord>;
  if (
    typeof raw.waveId !== "string" ||
    !raw.waveId ||
    typeof raw.conductorSessionId !== "string" ||
    !raw.conductorSessionId ||
    !OUTCOMES.includes(raw.outcome as WaveTelemetryOutcome) ||
    !isFiniteTime(raw.closedAt)
  ) {
    return null;
  }
  const steps = Array.isArray(raw.steps)
    ? raw.steps.flatMap((step) => {
        const parsed = parseStep(step);
        return parsed ? [parsed] : [];
      })
    : [];
  return {
    waveId: raw.waveId,
    conductorSessionId: raw.conductorSessionId,
    ...(typeof raw.conductorHarnessId === "string" && raw.conductorHarnessId
      ? { conductorHarnessId: raw.conductorHarnessId }
      : {}),
    ...(typeof raw.conductorModelId === "string" && raw.conductorModelId
      ? { conductorModelId: raw.conductorModelId }
      : {}),
    rootRequestId:
      typeof raw.rootRequestId === "string" && raw.rootRequestId
        ? raw.rootRequestId
        : raw.waveId,
    revisionIndex: isCount(raw.revisionIndex) ? raw.revisionIndex : 0,
    createdAt: isFiniteTime(raw.createdAt) ? raw.createdAt : raw.closedAt,
    closedAt: raw.closedAt,
    durationMs: isCount(raw.durationMs) ? raw.durationMs : 0,
    outcome: raw.outcome as WaveTelemetryOutcome,
    ...(typeof raw.closureReason === "string"
      ? { closureReason: raw.closureReason as WaveClosureReason }
      : {}),
    digestAttempt: isCount(raw.digestAttempt) ? raw.digestAttempt : 0,
    stepCount: isCount(raw.stepCount) ? raw.stepCount : steps.length,
    degradedStepCount: isCount(raw.degradedStepCount)
      ? raw.degradedStepCount
      : 0,
    ...(isCount(raw.gitDirtyAtAdmission)
      ? { gitDirtyAtAdmission: raw.gitDirtyAtAdmission }
      : {}),
    ...(isCount(raw.gitDirtyAtDigest)
      ? { gitDirtyAtDigest: raw.gitDirtyAtDigest }
      : {}),
    ...(isCount(raw.totalTokens) ? { totalTokens: raw.totalTokens } : {}),
    ...(isMoney(raw.costUsd) ? { costUsd: raw.costUsd } : {}),
    steps,
  };
}

/** Field-by-field salvage, same discipline as the wave store's parse. */
export function parseWaveTelemetry(value: unknown): WaveTelemetryState {
  const empty = emptyWaveTelemetryState();
  if (!value || typeof value !== "object") return empty;
  const raw = value as Partial<WaveTelemetryState>;
  const records = Array.isArray(raw.records)
    ? raw.records.flatMap((record) => {
        const parsed = parseRecord(record);
        return parsed ? [parsed] : [];
      })
    : [];
  const counters = (raw.counters ?? {}) as Partial<WaveTelemetryCounters>;
  const highWater: Record<string, number> = {};
  if (raw.planlessHighWater && typeof raw.planlessHighWater === "object") {
    for (const [key, mark] of Object.entries(raw.planlessHighWater)) {
      if (key && isFiniteTime(mark)) highWater[key] = mark;
    }
  }
  return {
    records: capRecords(records),
    counters: {
      planlessTurns: isCount(counters.planlessTurns)
        ? counters.planlessTurns
        : 0,
      admittedWaves: isCount(counters.admittedWaves)
        ? counters.admittedWaves
        : 0,
      rejectedPlans: isCount(counters.rejectedPlans)
        ? counters.rejectedPlans
        : 0,
      concurrentRefusals: isCount(counters.concurrentRefusals)
        ? counters.concurrentRefusals
        : 0,
    },
    planlessHighWater: highWater,
  };
}

/** Newest-closed last; oldest records fall off the front. */
function capRecords(records: WaveTelemetryRecord[]): WaveTelemetryRecord[] {
  if (records.length <= MAX_WAVE_TELEMETRY_RECORDS) return records;
  return [...records]
    .sort((left, right) => left.closedAt - right.closedAt)
    .slice(records.length - MAX_WAVE_TELEMETRY_RECORDS);
}

let cache: WaveTelemetryState | null = null;

function load(): WaveTelemetryState {
  if (typeof window === "undefined") return emptyWaveTelemetryState();
  try {
    const stored = window.localStorage.getItem(WAVE_TELEMETRY_STORAGE_KEY);
    if (!stored) return emptyWaveTelemetryState();
    return parseWaveTelemetry(JSON.parse(stored));
  } catch {
    return emptyWaveTelemetryState();
  }
}

export function getWaveTelemetry(): WaveTelemetryState {
  if (cache === null) cache = load();
  return cache;
}

/**
 * In-process subscribers, so a reader can re-render when a wave closes.
 *
 * Deliberately not a window event: telemetry is written and read inside one
 * renderer, and the storage event would fire for other tabs the app does not
 * have. `save` is a cold path — once per wave close — so notifying here costs
 * nothing on any hot path.
 */
const listeners = new Set<() => void>();

/** Subscribes to wave-close writes. Returns the unsubscribe. */
export function subscribeWaveTelemetry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const telemetryDocument = conductorDocument<WaveTelemetryState>({
  path: WAVE_TELEMETRY_DOCUMENT,
  legacyStorageKey: WAVE_TELEMETRY_STORAGE_KEY,
  scope: "telemetry",
  parse: parseWaveTelemetry,
  serialize: (state) => state,
});

/**
 * Folds the folder's history into the live counters (P24).
 *
 * Records are unioned by wave id — the file holds the previous runs, memory
 * holds this one — and the lifetime counters are summed only when memory has
 * not counted anything yet. Adding them unconditionally would double every
 * number on a hydration that raced a wave, and telemetry that overstates
 * itself is worse than telemetry that is late.
 */
export async function hydrateWaveTelemetry(): Promise<void> {
  if (!telemetryDocument.active) return;
  const stored = await telemetryDocument.read();
  if (!stored) return;
  const live = getWaveTelemetry();
  const liveWaveIds = new Set(live.records.map((record) => record.waveId));
  const liveCounted =
    live.counters.planlessTurns +
    live.counters.admittedWaves +
    live.counters.rejectedPlans +
    live.counters.concurrentRefusals;
  save({
    ...stored,
    ...live,
    counters: liveCounted === 0 ? stored.counters : live.counters,
    planlessHighWater: {
      ...stored.planlessHighWater,
      ...live.planlessHighWater,
    },
    records: capRecords([
      ...stored.records.filter((record) => !liveWaveIds.has(record.waveId)),
      ...live.records,
    ]),
  });
}

/** Pushes a queued telemetry write to disk. Shutdown, and tests. */
export function flushWaveTelemetryWrites(): Promise<void> {
  return telemetryDocument.flush();
}

function save(next: WaveTelemetryState): void {
  cache = next;
  if (telemetryDocument.active) {
    telemetryDocument.write(next);
  } else if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        WAVE_TELEMETRY_STORAGE_KEY,
        JSON.stringify(next),
      );
    } catch (error) {
      // Telemetry is never load-bearing; a failed persist loses history only.
      // It is still the same quota, and the same warning is owed.
      notePersistFailure("telemetry", error);
    }
  }
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A reader that throws must not take the wave's close path with it.
    }
  }
}

function nodeForStep(
  wave: WaveState,
  stepIndex: number,
  sessionId: string | undefined,
): SessionNode | undefined {
  const graph = useConductorGraphStore.getState();
  if (sessionId) {
    const direct = graph.nodesById[sessionId];
    if (direct) return direct;
  }
  return Object.values(graph.nodesById).find(
    (node) => node.waveId === wave.waveId && node.stepIndex === stepIndex,
  );
}

function buildRecord(
  wave: WaveState,
  outcome: WaveTelemetryOutcome,
  closureReason: WaveClosureReason | undefined,
  closedAt: number,
): WaveTelemetryRecord {
  const ledger = getUsageLedger();
  const steps: WaveStepTelemetry[] = wave.steps.map((step) => {
    const node = nodeForStep(wave, step.stepIndex, step.sessionId);
    const usage = step.sessionId ? ledger.sessions[step.sessionId] : undefined;
    const startedAt = node?.createdAt;
    const finishedAt = node?.finishedAt;
    const durationMs =
      startedAt !== undefined && finishedAt !== undefined
        ? Math.max(0, finishedAt - startedAt)
        : undefined;
    return {
      stepIndex: step.stepIndex,
      role: step.role,
      access: step.access === "all" ? "all" : "none",
      outcome:
        step.phase === "failed" ? "failed" : (node?.status ?? "never-ran"),
      reportDegraded: step.reportDegraded === true,
      ...(node?.harnessId ? { harnessId: node.harnessId } : {}),
      ...(node?.modelId ? { modelId: node.modelId } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(finishedAt !== undefined ? { finishedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(usage && isCount(usage.totalTokens) && usage.totalTokens > 0
        ? { totalTokens: usage.totalTokens }
        : {}),
      ...(usage && isMoney(usage.costUsd) ? { costUsd: usage.costUsd } : {}),
    };
  });
  const tokenTotals = steps.flatMap((step) =>
    step.totalTokens !== undefined ? [step.totalTokens] : [],
  );
  const costTotals = steps.flatMap((step) =>
    step.costUsd !== undefined ? [step.costUsd] : [],
  );
  const conductor =
    useConductorGraphStore.getState().nodesById[wave.conductorSessionId];
  return {
    waveId: wave.waveId,
    conductorSessionId: wave.conductorSessionId,
    // The conductor's own model, so the facts ledger can say which model
    // plans well here and which one keeps producing waves nothing accepts.
    ...(conductor?.harnessId
      ? { conductorHarnessId: conductor.harnessId }
      : {}),
    ...(conductor?.modelId ? { conductorModelId: conductor.modelId } : {}),
    rootRequestId: wave.rootRequestId,
    revisionIndex: wave.revisionCount,
    createdAt: wave.createdAt,
    closedAt,
    durationMs: Math.max(0, closedAt - wave.createdAt),
    outcome,
    ...(closureReason ? { closureReason } : {}),
    digestAttempt: wave.digestAttempt,
    stepCount: wave.steps.length,
    degradedStepCount: steps.filter((step) => step.reportDegraded).length,
    ...(wave.gitDirtyAtAdmission !== undefined
      ? { gitDirtyAtAdmission: wave.gitDirtyAtAdmission }
      : {}),
    ...(wave.gitDirtyAtDigest !== undefined
      ? { gitDirtyAtDigest: wave.gitDirtyAtDigest }
      : {}),
    ...(tokenTotals.length > 0
      ? { totalTokens: tokenTotals.reduce((sum, value) => sum + value, 0) }
      : {}),
    ...(costTotals.length > 0
      ? { costUsd: costTotals.reduce((sum, value) => sum + value, 0) }
      : {}),
    steps,
  };
}

/**
 * Records one wave leaving the live loop. Upserts by `waveId`; capped.
 *
 * Called from every close path — verdict decisions, the interrupted park, an
 * undeliverable digest, the operator's stop, the orphan prune. Failures are
 * swallowed whole: the loop's own transition must never depend on telemetry.
 */
export function recordWaveClose(
  wave: WaveState,
  outcome: WaveTelemetryOutcome,
  closureReason?: WaveClosureReason,
  closedAt = Date.now(),
): void {
  try {
    const record = buildRecord(wave, outcome, closureReason, closedAt);
    const current = getWaveTelemetry();
    save({
      ...current,
      records: capRecords([
        ...current.records.filter(
          (candidate) => candidate.waveId !== record.waveId,
        ),
        record,
      ]),
    });
  } catch {
    // Never load-bearing.
  }
}

/** Bumps one denominator counter. */
export function bumpWaveTelemetryCounter(
  counter: keyof WaveTelemetryCounters,
): void {
  try {
    const current = getWaveTelemetry();
    save({
      ...current,
      counters: {
        ...current.counters,
        [counter]: current.counters[counter] + 1,
      },
    });
  } catch {
    // Never load-bearing.
  }
}

/**
 * Counts one settled, planless conductor turn — the wave-rate denominator.
 *
 * Deduplicated across restarts by the per-conductor high-water mark on the
 * message's `created` time: the in-process scanned-set forgets on restart and
 * every hydrated transcript is re-scanned, so without the mark each restart
 * would count the same history again. Transcript order is chronological, so
 * a turn at-or-below the mark has been counted before.
 */
export function countPlanlessConductorTurn(
  conductorSessionId: string,
  createdAt: number,
): void {
  try {
    if (!conductorSessionId || !Number.isFinite(createdAt)) return;
    const current = getWaveTelemetry();
    const mark = current.planlessHighWater[conductorSessionId] ?? 0;
    if (createdAt <= mark) return;
    save({
      ...current,
      counters: {
        ...current.counters,
        planlessTurns: current.counters.planlessTurns + 1,
      },
      planlessHighWater: {
        ...current.planlessHighWater,
        [conductorSessionId]: createdAt,
      },
    });
  } catch {
    // Never load-bearing.
  }
}

/** Clears the cache and the persisted payload. Tests only. */
/** Live telemetry for a React reader. Re-renders when a wave closes. */
export function useWaveTelemetry(): WaveTelemetryState {
  return useSyncExternalStore(
    subscribeWaveTelemetry,
    getWaveTelemetry,
    emptyWaveTelemetryState,
  );
}

export function resetWaveTelemetryForTests(): void {
  cache = null;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(WAVE_TELEMETRY_STORAGE_KEY);
    } catch {
      // Ignore.
    }
  }
}
