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

import type {
  JudgeInput,
  JudgePoolEntry,
  ProviderDataUseSetting,
} from "../types";

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
/** The most account ids, and the longest one, a pool entry keeps. */
export const MAX_JUDGE_ACCOUNTS = 16;
export const MAX_JUDGE_ACCOUNT_LENGTH = 128;
/** Every kind of rubric a judge can be limited to, in stored order. */
export const JUDGE_INPUTS: readonly JudgeInput[] = ["text", "visual"];
/** The longest provider id the owner's data-use word is kept for. */
export const MAX_DATA_USE_PROVIDER_ID_LENGTH = 128;
/** The most version ids the owner's suite exclusions keep. */
export const MAX_BOARD_EXCLUSIONS = 4096;
/** The longest version id an exclusion keeps. */
export const MAX_VERSION_ID_LENGTH = 128;

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
   * when the model has no effort control, `inputs` absent for both kinds.
   * Whether an entry may judge at all is its provider's data use.
   */
  judgePool: JudgePoolEntry[];
  /**
   * The owner's word on what each provider may do with what benchmark turns
   * send it, by provider id. A provider that may train on submitted data
   * runs only train tasks and never judges. A provider not named here keeps
   * the default the backend owns, so this holds only what the owner stated.
   */
  providerDataUse: Record<string, ProviderDataUseSetting>;
  /**
   * Version ids the owner keeps out of the measurement suite a board row
   * must cover to count as fully tested, beside the cases a holdout or a
   * campaign reserves. Edited in the document itself; every write keeps it.
   */
  boardExclusions: string[];
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
  // A pool written before provider data use may carry a per-entry
  // `disclosureConfirmed`: it is read past and never written back.
  const stored = raw as {
    providerId?: unknown;
    modelId?: unknown;
    effort?: unknown;
    inputs?: unknown;
    accounts?: unknown;
  };
  const providerId = boundedText(stored.providerId, MAX_JUDGE_ID_LENGTH);
  const modelId = boundedText(stored.modelId, MAX_JUDGE_ID_LENGTH);
  if (!providerId || !modelId) return null;
  let effort: string | null = null;
  if (stored.effort !== undefined && stored.effort !== null) {
    effort = boundedText(stored.effort, MAX_JUDGE_EFFORT_LENGTH);
    if (!effort) return null;
  }
  const entry: JudgePoolEntry = { providerId, modelId, effort };
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
  if (stored.accounts !== undefined && stored.accounts !== null) {
    // The accounts an entry may sit on, as the backend reads them: exact
    // ids, never trimmed, or the backend drops the entry.
    const accounts = stored.accounts;
    if (
      !Array.isArray(accounts) ||
      accounts.length === 0 ||
      accounts.length > MAX_JUDGE_ACCOUNTS ||
      !accounts.every(
        (account) =>
          typeof account === "string" &&
          account.length > 0 &&
          new TextEncoder().encode(account).length <=
            MAX_JUDGE_ACCOUNT_LENGTH &&
          account.trim() === account,
      )
    )
      return null;
    entry.accounts = [...accounts];
  }
  return entry;
}

/**
 * The identity of a pool entry: one model at one effort. Entries that differ
 * only in what they judge are duplicates.
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

/** A provider id as the data-use word is kept under, or null. */
export function normalizeDataUseProviderId(raw: unknown): string | null {
  return boundedText(raw, MAX_DATA_USE_PROVIDER_ID_LENGTH);
}

/**
 * The owner's data-use word as stored: each provider id that is nonempty
 * once trimmed and at most {@link MAX_DATA_USE_PROVIDER_ID_LENGTH} long,
 * whose value is an object with a boolean `trainsOnSubmissions`, the first
 * of ids equal once trimmed. Anything else is dropped, and anything but an
 * object reads as empty: every provider then keeps its default.
 */
export function normalizeProviderDataUse(
  raw: unknown,
): Record<string, ProviderDataUseSetting> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const stated = new Map<string, ProviderDataUseSetting>();
  for (const [key, value] of Object.entries(raw)) {
    const providerId = normalizeDataUseProviderId(key);
    if (!providerId || stated.has(providerId)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const { trainsOnSubmissions } = value as { trainsOnSubmissions?: unknown };
    if (typeof trainsOnSubmissions !== "boolean") continue;
    stated.set(providerId, { trainsOnSubmissions });
  }
  // Own data properties, so no id can reach the prototype.
  return Object.fromEntries(stated);
}

/** The owner's suite exclusions as stored: distinct trimmed version ids. */
export function normalizeBoardExclusions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  for (const item of raw) {
    const id = boundedText(item, MAX_VERSION_ID_LENGTH);
    if (id) ids.add(id);
    if (ids.size === MAX_BOARD_EXCLUSIONS) break;
  }
  return [...ids];
}

export function parseBenchmarkSettings(raw: unknown): BenchmarkSettings {
  const stored =
    raw && typeof raw === "object"
      ? (raw as {
          timeLimitMinutes?: unknown;
          creditLimit?: unknown;
          judgePool?: unknown;
          providerDataUse?: unknown;
          boardExclusions?: unknown;
        })
      : {};
  return {
    timeLimitMinutes:
      typeof stored.timeLimitMinutes === "number"
        ? clampTimeLimitMinutes(stored.timeLimitMinutes)
        : DEFAULT_TIME_LIMIT_MINUTES,
    creditLimit: normalizeCreditLimit(stored.creditLimit),
    judgePool: normalizeJudgePool(stored.judgePool),
    providerDataUse: normalizeProviderDataUse(stored.providerDataUse),
    boardExclusions: normalizeBoardExclusions(stored.boardExclusions),
  };
}

/**
 * The document as written. Every write carries the whole pool and the whole
 * data-use word: the backend reads its judges, and what each provider may
 * receive, from this file, so a change of the time limit must never drop
 * them.
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
      ...(entry.accounts ? { accounts: [...entry.accounts] } : {}),
    })),
    providerDataUse: Object.fromEntries(
      Object.entries(settings.providerDataUse).map(([providerId, stated]) => [
        providerId,
        { trainsOnSubmissions: stated.trainsOnSubmissions },
      ]),
    ),
    // Written only when the owner listed some, so a document without the
    // list stays as it was.
    ...(settings.boardExclusions.length
      ? { boardExclusions: [...settings.boardExclusions] }
      : {}),
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
   * Records the owner's word on whether `providerId` may train on submitted
   * data. Nothing changes for an id the document would not keep.
   */
  setProviderTrainsOnSubmissions: (
    providerId: string,
    trainsOnSubmissions: boolean,
  ) => void;
  /**
   * Takes the owner's word on `providerId` back: the provider keeps the
   * default the backend owns again.
   */
  clearProviderDataUse: (providerId: string) => void;
}

export const DEFAULT_BENCHMARK_SETTINGS: BenchmarkSettings = {
  timeLimitMinutes: DEFAULT_TIME_LIMIT_MINUTES,
  creditLimit: null,
  judgePool: [],
  providerDataUse: {},
  boardExclusions: [],
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
      setProviderTrainsOnSubmissions: (providerId, trainsOnSubmissions) => {
        const id = normalizeDataUseProviderId(providerId);
        if (!id) return;
        const stated = get().settings.providerDataUse;
        const known = Object.hasOwn(stated, id);
        if (known && stated[id].trainsOnSubmissions === trainsOnSubmissions)
          return;
        // Rebuilt from entries rather than assigned, so an id such as
        // `__proto__` stays an ordinary key.
        const entries: [string, ProviderDataUseSetting][] = known
          ? Object.entries(stated).map(([other, value]) => [
              other,
              other === id ? { trainsOnSubmissions } : value,
            ])
          : [...Object.entries(stated), [id, { trainsOnSubmissions }]];
        save({ providerDataUse: Object.fromEntries(entries) });
      },
      clearProviderDataUse: (providerId) => {
        const id = normalizeDataUseProviderId(providerId);
        const stated = get().settings.providerDataUse;
        if (!id || !Object.hasOwn(stated, id)) return;
        save({
          providerDataUse: Object.fromEntries(
            Object.entries(stated).filter(([other]) => other !== id),
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
 * Writes a queued change now. The backend reads the judge pool and the
 * provider data use from the document, so what it makes of them is read
 * again after this.
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
