/**
 * Benchmark settings: edited in Settings, persisted as a document in the
 * Distill folder beside the benchmark database.
 *
 * Like every document store here, it starts on the defaults and refuses to
 * write until its read has landed, so a default written during startup never
 * replaces the operator's value.
 */

import { create } from "zustand";

import { distillDocument } from "@/shared/lib/distillDocument";

import type { JudgeInput, JudgePoolEntry } from "../types";

export const BENCHMARK_SETTINGS_DOCUMENT = "benchmarks/settings.json";

/**
 * How long one test may run, in minutes. It only stops a test that never
 * finishes: a model on its highest effort may work an hour or two on one
 * case, and speed is measured on its own board.
 */
export const DEFAULT_TIME_LIMIT_MINUTES = 4 * 60;

/** `benchmarks::MAX_TIME_LIMIT_SECONDS`, in minutes. */
export const MAX_TIME_LIMIT_MINUTES = 24 * 60;

/** The most entries the judge pool keeps; later ones are dropped. */
export const MAX_JUDGE_POOL_ENTRIES = 32;
/** The longest provider or model id a pool entry keeps. */
export const MAX_JUDGE_ID_LENGTH = 256;
/** The longest effort a pool entry keeps. */
export const MAX_JUDGE_EFFORT_LENGTH = 64;
/** Every kind of rubric a judge can be limited to, in stored order. */
export const JUDGE_INPUTS: readonly JudgeInput[] = ["text", "visual"];

export interface BenchmarkSettings {
  timeLimitMinutes: number;
  /**
   * The most purchased credits benchmark tests may spend once an account's
   * plan usage is spent; null keeps credits off. The backend reads it before
   * every test and measures the spending.
   */
  creditLimit: number | null;
  /**
   * The models rubric judges are drawn from. The backend reads it from this
   * document and seats an entry only after it passed a judge calibration;
   * empty until the owner adds one. Normalized: ids trimmed, `effort` null
   * when the model has no effort control, `inputs` absent for both kinds,
   * `disclosureConfirmed` always set.
   */
  judgePool: JudgePoolEntry[];
}

export function clampTimeLimitMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_TIME_LIMIT_MINUTES;
  return Math.min(MAX_TIME_LIMIT_MINUTES, Math.max(1, Math.round(minutes)));
}

/** A credit limit as stored: a whole number of credits, or off. */
export function normalizeCreditLimit(limit: unknown): number | null {
  return typeof limit === "number" && Number.isFinite(limit) && limit >= 0
    ? Math.round(limit)
    : null;
}

/** `value` trimmed when it is a nonempty string of at most `max` characters. */
function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
}

function isJudgeInput(value: unknown): value is JudgeInput {
  return JUDGE_INPUTS.includes(value as JudgeInput);
}

/** One pool entry as stored, or null when it is not one. */
export function normalizeJudgePoolEntry(raw: unknown): JudgePoolEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const stored = raw as {
    providerId?: unknown;
    modelId?: unknown;
    effort?: unknown;
    inputs?: unknown;
    disclosureConfirmed?: unknown;
  };
  const providerId = boundedText(stored.providerId, MAX_JUDGE_ID_LENGTH);
  const modelId = boundedText(stored.modelId, MAX_JUDGE_ID_LENGTH);
  if (!providerId || !modelId) return null;
  let effort: string | null = null;
  if (stored.effort !== undefined && stored.effort !== null) {
    effort = boundedText(stored.effort, MAX_JUDGE_EFFORT_LENGTH);
    if (!effort) return null;
  }
  const entry: JudgePoolEntry = {
    providerId,
    modelId,
    effort,
    // Private rubrics reach a judge only on the owner's explicit word.
    disclosureConfirmed: stored.disclosureConfirmed === true,
  };
  if (stored.inputs !== undefined && stored.inputs !== null) {
    const inputs = stored.inputs;
    // The backend drops an entry that judges nothing, so this does too.
    if (
      !Array.isArray(inputs) ||
      inputs.length === 0 ||
      !inputs.every(isJudgeInput)
    )
      return null;
    entry.inputs = JUDGE_INPUTS.filter((input) => inputs.includes(input));
  }
  return entry;
}

/**
 * The identity of a pool entry: one model at one effort. Entries that differ
 * only in what they judge or in the data-use confirmation are duplicates.
 */
export function judgePoolEntryKey(
  entry: Pick<JudgePoolEntry, "providerId" | "modelId" | "effort">,
): string {
  return JSON.stringify([
    entry.providerId,
    entry.modelId,
    entry.effort ?? null,
  ]);
}

/**
 * The pool as stored: the valid entries in order, the first of duplicates,
 * at most {@link MAX_JUDGE_POOL_ENTRIES}. Anything else reads as empty.
 */
export function normalizeJudgePool(raw: unknown): JudgePoolEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const pool: JudgePoolEntry[] = [];
  for (const item of raw) {
    const entry = normalizeJudgePoolEntry(item);
    if (!entry) continue;
    const key = judgePoolEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(entry);
    if (pool.length === MAX_JUDGE_POOL_ENTRIES) break;
  }
  return pool;
}

export function parseBenchmarkSettings(raw: unknown): BenchmarkSettings {
  const stored =
    raw && typeof raw === "object"
      ? (raw as {
          timeLimitMinutes?: unknown;
          creditLimit?: unknown;
          judgePool?: unknown;
        })
      : {};
  return {
    timeLimitMinutes:
      typeof stored.timeLimitMinutes === "number"
        ? clampTimeLimitMinutes(stored.timeLimitMinutes)
        : DEFAULT_TIME_LIMIT_MINUTES,
    creditLimit: normalizeCreditLimit(stored.creditLimit),
    judgePool: normalizeJudgePool(stored.judgePool),
  };
}

/**
 * The document as written. Every write carries the whole pool: the backend
 * reads its judges from this file, so a change of the time limit must never
 * drop them.
 */
export function serializeBenchmarkSettings(settings: BenchmarkSettings) {
  return {
    timeLimitMinutes: settings.timeLimitMinutes,
    creditLimit: settings.creditLimit,
    judgePool: settings.judgePool.map((entry) => ({
      providerId: entry.providerId,
      modelId: entry.modelId,
      effort: entry.effort ?? null,
      ...(entry.inputs ? { inputs: [...entry.inputs] } : {}),
      disclosureConfirmed: entry.disclosureConfirmed === true,
    })),
  };
}

const document = distillDocument<BenchmarkSettings>({
  path: BENCHMARK_SETTINGS_DOCUMENT,
  legacyStorageKey: "distill:benchmark-settings",
  parse: parseBenchmarkSettings,
  serialize: serializeBenchmarkSettings,
});

interface BenchmarkSettingsState {
  settings: BenchmarkSettings;
  /** False until the stored document has been read. Writes wait for it. */
  hydrated: boolean;
  setTimeLimitMinutes: (minutes: number) => void;
  setCreditLimit: (limit: number | null) => void;
  /** Replaces the pool, normalized as a read would. */
  setJudgePool: (pool: readonly JudgePoolEntry[]) => void;
  /**
   * Adds `entry` at the end of the pool. False, and nothing changes, when it
   * is not a valid entry, is already in the pool, or the pool is full.
   */
  addJudgePoolEntry: (entry: JudgePoolEntry) => boolean;
  /** Takes the entry with `entry`'s model and effort out of the pool. */
  removeJudgePoolEntry: (entry: JudgePoolEntry) => void;
  /**
   * Records whether the owner confirmed the data use of the provider of the
   * entry with `entry`'s model and effort.
   */
  setJudgeDisclosureConfirmed: (
    entry: JudgePoolEntry,
    confirmed: boolean,
  ) => void;
}

export const DEFAULT_BENCHMARK_SETTINGS: BenchmarkSettings = {
  timeLimitMinutes: DEFAULT_TIME_LIMIT_MINUTES,
  creditLimit: null,
  judgePool: [],
};

export const useBenchmarkSettingsStore = create<BenchmarkSettingsState>(
  (set, get) => {
    // Every change goes through here, so each write carries the whole
    // document, and none is made before the stored one has been read.
    const save = (changes: Partial<BenchmarkSettings>) => {
      const settings = { ...get().settings, ...changes };
      set({ settings });
      if (get().hydrated) document.write(settings);
    };
    return {
      settings: DEFAULT_BENCHMARK_SETTINGS,
      hydrated: false,
      setTimeLimitMinutes: (minutes) => {
        save({ timeLimitMinutes: clampTimeLimitMinutes(minutes) });
      },
      setCreditLimit: (limit) => {
        save({ creditLimit: normalizeCreditLimit(limit) });
      },
      setJudgePool: (pool) => {
        save({ judgePool: normalizeJudgePool(pool) });
      },
      addJudgePoolEntry: (entry) => {
        const added = normalizeJudgePoolEntry(entry);
        const pool = get().settings.judgePool;
        if (
          !added ||
          pool.length >= MAX_JUDGE_POOL_ENTRIES ||
          pool.some(
            (other) => judgePoolEntryKey(other) === judgePoolEntryKey(added),
          )
        )
          return false;
        save({ judgePool: [...pool, added] });
        return true;
      },
      removeJudgePoolEntry: (entry) => {
        const key = judgePoolEntryKey(entry);
        const pool = get().settings.judgePool;
        if (!pool.some((other) => judgePoolEntryKey(other) === key)) return;
        save({
          judgePool: pool.filter((other) => judgePoolEntryKey(other) !== key),
        });
      },
      setJudgeDisclosureConfirmed: (entry, confirmed) => {
        const key = judgePoolEntryKey(entry);
        const pool = get().settings.judgePool;
        if (!pool.some((other) => judgePoolEntryKey(other) === key)) return;
        save({
          judgePool: pool.map((other) =>
            judgePoolEntryKey(other) === key
              ? { ...other, disclosureConfirmed: confirmed }
              : other,
          ),
        });
      },
    };
  },
);

export async function hydrateBenchmarkSettingsStore(): Promise<void> {
  const stored = await document.read();
  useBenchmarkSettingsStore.setState((state) => ({
    settings: stored ?? state.settings,
    hydrated: true,
  }));
}

/**
 * Writes a queued change now. The backend reads the judge pool from the
 * document, so what it makes of the pool is read again after this.
 */
export function flushBenchmarkSettings(): Promise<void> {
  return document.flush();
}

/**
 * The time limit a new run gives each of `versions`, in seconds: the setting,
 * and never less than the least time a chosen case asks a run to allow.
 */
export function runTimeLimitSeconds(
  versions: readonly { manifest: { limits: { timeoutSeconds: number } } }[],
): number {
  return Math.max(
    useBenchmarkSettingsStore.getState().settings.timeLimitMinutes * 60,
    ...versions.map((version) => version.manifest.limits.timeoutSeconds),
  );
}
