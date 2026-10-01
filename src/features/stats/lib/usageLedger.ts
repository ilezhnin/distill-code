import { useSyncExternalStore } from "react";
import type { ChatState } from "@/shared/types/chat";
import { formatLocalDay, parseTimestamp } from "./usageFormatters";
import type {
  UsageArchivedRecord,
  UsageDailyRecord,
  UsageLedger,
  UsageSessionRecord,
  UsageSessionSource,
  UsageSummary,
  UsageTokenSnapshot,
} from "./usageTypes";
import {
  USAGE_LEDGER_CHANGED_EVENT,
  USAGE_LEDGER_STORAGE_KEY,
  USAGE_LEDGER_VERSION,
} from "./usageTypes";
import { DEFAULT_HARNESS_ID } from "@/features/providers/curatedProviders";
import { isDesktopRuntime } from "@/shared/api/distillStore";
import { distillDocument } from "@/shared/lib/distillDocument";

const WORKING_CHAT_STATES: ReadonlySet<ChatState> = new Set([
  "thinking",
  "streaming",
  "waiting",
  "compacting",
]);

const EMPTY_LEDGER: UsageLedger = {
  version: USAGE_LEDGER_VERSION,
  firstEventAt: null,
  lastUpdatedAt: null,
  sessions: {},
  daily: {},
};

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Usage events arrive in bursts (a turn records tokens, worked time and a
 * usage replace within milliseconds), so the ledger is kept in memory and
 * persisted at most once per window. Pending writes are flushed when the
 * window hides so a close cannot drop them.
 */
const LEDGER_WRITE_DEBOUNCE_MS = 1_000;
/** Daily token rollups are kept for this long. */
const DAILY_RETENTION_MS = 400 * DAY_MS;

const workStartedAtBySession = new Map<string, number>();
const listeners = new Set<() => void>();

let cachedLedger: UsageLedger | null = null;
let cachedSerialized: string | null = null;
let removeWindowListener: (() => void) | undefined;
let pendingWrite = false;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let removeFlushListeners: (() => void) | undefined;
let storageWriteWarned = false;
let nativeReady = false;
let nativeStoredLedger: UsageLedger | null = null;
const ledgerDocument = distillDocument<UsageLedger>({
  path: "state/usage-ledger.json",
  legacyStorageKey: USAGE_LEDGER_STORAGE_KEY,
  parse: (value) => parseLedger(value) ?? cloneLedger(EMPTY_LEDGER),
  serialize: (value) => value,
  onWriteError: (error) => {
    pendingWrite = true;
    warnAboutStorageFailureOnce(error);
  },
  // The store announces each write to the window that made it as well, and
  // re-reading half a megabyte of our own ledger — then merging it into a
  // pending change and writing again — kept a busy window in a write loop.
  recognizeOwnWrites: true,
});

export async function initializeUsageLedger(): Promise<void> {
  if (!isDesktopRuntime() || nativeReady) return;
  nativeStoredLedger = await ledgerDocument.read();
  cachedLedger = nativeStoredLedger ?? cloneLedger(EMPTY_LEDGER);
  nativeReady = true;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<string>("distill-document-changed", (event) => {
    if (event.payload !== "state/usage-ledger.json") return;
    void ledgerDocument
      .readExternal()
      .then((stored) => {
        // This window's own write coming back: there is nothing to adopt.
        if (stored === undefined) return;
        nativeStoredLedger = stored;
        handleStorageChange(
          new StorageEvent("storage", { key: USAGE_LEDGER_STORAGE_KEY }),
        );
      })
      .catch(warnAboutStorageFailureOnce);
  });
}

function emptySessionRecord(): UsageSessionRecord {
  return {
    providerId: DEFAULT_HARNESS_ID,
    modelId: null,
    modelName: null,
    createdAt: 0,
    lastActivityAt: 0,
    messageCount: 0,
    started: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    costUsd: null,
    costCurrency: null,
    turns: 0,
    workedMs: 0,
  };
}

function emptyDailyRecord(): UsageDailyRecord {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    byProvider: {},
  };
}

function cloneLedger(ledger: UsageLedger): UsageLedger {
  return {
    version: USAGE_LEDGER_VERSION,
    firstEventAt: ledger.firstEventAt,
    lastUpdatedAt: ledger.lastUpdatedAt,
    sessions: Object.fromEntries(
      Object.entries(ledger.sessions).map(([id, session]) => [
        id,
        { ...session },
      ]),
    ),
    daily: Object.fromEntries(
      Object.entries(ledger.daily).map(([day, record]) => [
        day,
        { ...record, byProvider: { ...record.byProvider } },
      ]),
    ),
    ...(ledger.archived
      ? {
          archived: Object.fromEntries(
            Object.entries(ledger.archived).map(([providerId, record]) => [
              providerId,
              { ...record },
            ]),
          ),
        }
      : {}),
  };
}

/**
 * A reported currency, trimmed and upper-cased so "usd" and "USD" are one
 * currency. `null` means the source did not say, which every consumer reads as
 * USD — that is what the "$" figures on the stats page have always assumed.
 */
export function normalizeCostCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

/** A reported effort, or undefined when there is none to record. */
function normalizeEffort(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function asNonNegativeInt(value: unknown): number | null {
  if (!isFiniteNumber(value) || value < 0) return null;
  return Math.floor(value);
}

function parseSessionRecord(value: unknown): UsageSessionRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<UsageSessionRecord>;
  if (typeof raw.providerId !== "string" || !raw.providerId) return null;
  const createdAt = asNonNegativeInt(raw.createdAt) ?? 0;
  const lastActivityAt = asNonNegativeInt(raw.lastActivityAt) ?? createdAt;
  const effort = normalizeEffort(raw.effort);
  return {
    providerId: raw.providerId,
    ...(raw.origin === "benchmark" ? { origin: "benchmark" as const } : {}),
    modelId: typeof raw.modelId === "string" ? raw.modelId : null,
    modelName: typeof raw.modelName === "string" ? raw.modelName : null,
    ...(effort ? { effort } : {}),
    createdAt,
    lastActivityAt,
    messageCount: asNonNegativeInt(raw.messageCount) ?? 0,
    started: raw.started === true,
    inputTokens: asNonNegativeInt(raw.inputTokens) ?? 0,
    outputTokens: asNonNegativeInt(raw.outputTokens) ?? 0,
    cacheTokens: asNonNegativeInt(raw.cacheTokens) ?? 0,
    totalTokens: asNonNegativeInt(raw.totalTokens) ?? 0,
    costUsd: isFiniteNumber(raw.costUsd) ? raw.costUsd : null,
    costCurrency: normalizeCostCurrency(raw.costCurrency),
    turns: asNonNegativeInt(raw.turns) ?? 0,
    workedMs: asNonNegativeInt(raw.workedMs) ?? 0,
  };
}

function parseDailyRecord(value: unknown): UsageDailyRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<UsageDailyRecord>;
  const byProvider: Record<string, number> = {};
  if (raw.byProvider && typeof raw.byProvider === "object") {
    for (const [providerId, tokens] of Object.entries(raw.byProvider)) {
      const amount = asNonNegativeInt(tokens);
      if (amount != null) byProvider[providerId] = amount;
    }
  }
  return {
    totalTokens: asNonNegativeInt(raw.totalTokens) ?? 0,
    inputTokens: asNonNegativeInt(raw.inputTokens) ?? 0,
    outputTokens: asNonNegativeInt(raw.outputTokens) ?? 0,
    cacheTokens: asNonNegativeInt(raw.cacheTokens) ?? 0,
    byProvider,
  };
}

function parseArchivedRecord(value: unknown): UsageArchivedRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<UsageArchivedRecord>;
  return {
    sessions: asNonNegativeInt(raw.sessions) ?? 0,
    chatsStarted: asNonNegativeInt(raw.chatsStarted) ?? 0,
    messageCount: asNonNegativeInt(raw.messageCount) ?? 0,
    turns: asNonNegativeInt(raw.turns) ?? 0,
    inputTokens: asNonNegativeInt(raw.inputTokens) ?? 0,
    outputTokens: asNonNegativeInt(raw.outputTokens) ?? 0,
    cacheTokens: asNonNegativeInt(raw.cacheTokens) ?? 0,
    totalTokens: asNonNegativeInt(raw.totalTokens) ?? 0,
    costUsd: isFiniteNumber(raw.costUsd) ? raw.costUsd : null,
    costCurrency: normalizeCostCurrency(raw.costCurrency),
    ...(raw.hasMissingCost === true ? { hasMissingCost: true } : {}),
    workedMs: asNonNegativeInt(raw.workedMs) ?? 0,
    activeDays: asNonNegativeInt(raw.activeDays) ?? 0,
  };
}

function parseLedger(raw: unknown): UsageLedger | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = raw as Partial<UsageLedger> & { version?: number };
  if (parsed.version !== USAGE_LEDGER_VERSION) return null;

  const sessions: Record<string, UsageSessionRecord> = {};
  if (parsed.sessions && typeof parsed.sessions === "object") {
    for (const [id, record] of Object.entries(parsed.sessions)) {
      const session = parseSessionRecord(record);
      if (session) sessions[id] = session;
    }
  }

  const daily: Record<string, UsageDailyRecord> = {};
  if (parsed.daily && typeof parsed.daily === "object") {
    for (const [day, record] of Object.entries(parsed.daily)) {
      const dailyRecord = parseDailyRecord(record);
      if (dailyRecord) daily[day] = dailyRecord;
    }
  }

  const archivedEntries: [string, UsageArchivedRecord][] = [];
  if (parsed.archived && typeof parsed.archived === "object") {
    for (const [providerId, record] of Object.entries(parsed.archived)) {
      const archivedRecord = parseArchivedRecord(record);
      if (archivedRecord) archivedEntries.push([providerId, archivedRecord]);
    }
  }

  return {
    version: USAGE_LEDGER_VERSION,
    firstEventAt: asNonNegativeInt(parsed.firstEventAt),
    lastUpdatedAt: asNonNegativeInt(parsed.lastUpdatedAt),
    sessions,
    daily,
    ...(archivedEntries.length > 0
      ? { archived: Object.fromEntries(archivedEntries) }
      : {}),
  };
}

function readLedger(): UsageLedger {
  if (nativeReady) return cachedLedger ?? nativeStoredLedger ?? EMPTY_LEDGER;
  if (typeof window === "undefined") {
    return cloneLedger(EMPTY_LEDGER);
  }
  // A debounced write is still pending, so the in-memory ledger is newer than
  // whatever localStorage holds.
  if (pendingWrite && cachedLedger) {
    return cachedLedger;
  }
  try {
    const stored = window.localStorage.getItem(USAGE_LEDGER_STORAGE_KEY);
    if (stored === cachedSerialized && cachedLedger) {
      return cachedLedger;
    }
    if (!stored) {
      cachedSerialized = stored;
      cachedLedger = cloneLedger(EMPTY_LEDGER);
      return cachedLedger;
    }
    const parsed = parseLedger(JSON.parse(stored) as unknown);
    cachedSerialized = stored;
    cachedLedger = parsed ? parsed : cloneLedger(EMPTY_LEDGER);
    return cachedLedger;
  } catch {
    cachedLedger = cloneLedger(EMPTY_LEDGER);
    cachedSerialized = null;
    return cachedLedger;
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Keep session identities and counters: dropping them lets a later sync
 * count the same historical chat again. Existing legacy aggregates are kept
 * unchanged because they contain no IDs from which to reconstruct ownership. */
function pruneLedger(ledger: UsageLedger, now: number): UsageLedger {
  const dailyCutoff = formatLocalDay(new Date(now - DAILY_RETENTION_MS));
  const dailyEntries = Object.entries(ledger.daily).filter(
    ([day]) => day >= dailyCutoff,
  );
  if (dailyEntries.length === Object.keys(ledger.daily).length) return ledger;
  return { ...ledger, daily: Object.fromEntries(dailyEntries) };
}

function warnAboutStorageFailureOnce(error: unknown): void {
  if (storageWriteWarned) return;
  storageWriteWarned = true;
  console.warn(
    "Usage stats could not be saved; they will stay in memory only for this run:",
    error,
  );
}

function installFlushListeners(): void {
  if (removeFlushListeners || typeof window === "undefined") return;
  const flushOnHide = () => {
    flushUsageLedger();
  };
  const flushOnVisibilityChange = () => {
    if (document.visibilityState === "hidden") flushUsageLedger();
  };
  window.addEventListener("pagehide", flushOnHide);
  window.addEventListener("beforeunload", flushOnHide);
  document.addEventListener("visibilitychange", flushOnVisibilityChange);
  removeFlushListeners = () => {
    window.removeEventListener("pagehide", flushOnHide);
    window.removeEventListener("beforeunload", flushOnHide);
    document.removeEventListener("visibilitychange", flushOnVisibilityChange);
  };
}

/** Persists a pending ledger change immediately. */
export function flushUsageLedger(): void {
  if (writeTimer != null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (!pendingWrite || typeof window === "undefined") return;
  const pruned = pruneLedger(cachedLedger ?? EMPTY_LEDGER, Date.now());
  cachedLedger = pruned;
  if (nativeReady) {
    nativeStoredLedger = pruned;
    ledgerDocument.write(pruned);
    pendingWrite = false;
    void ledgerDocument.flush().catch(warnAboutStorageFailureOnce);
    return;
  }
  try {
    const serialized = JSON.stringify(pruned);
    window.localStorage.setItem(USAGE_LEDGER_STORAGE_KEY, serialized);
    cachedSerialized = serialized;
    pendingWrite = false;
  } catch (error) {
    // Keep `pendingWrite` set: reads then keep returning the in-memory ledger
    // instead of rolling back to the stored copy, and the next mutation
    // retries the write.
    warnAboutStorageFailureOnce(error);
  }
}

/** Arms the flush of a pending write, unless one is already armed. */
function scheduleLedgerFlush(): void {
  installFlushListeners();
  if (writeTimer == null) {
    writeTimer = setTimeout(() => {
      writeTimer = null;
      flushUsageLedger();
    }, LEDGER_WRITE_DEBOUNCE_MS);
  }
}

function writeLedger(next: UsageLedger): void {
  const stamped: UsageLedger = {
    ...next,
    lastUpdatedAt: Date.now(),
  };
  cachedLedger = stamped;
  if (typeof window === "undefined") {
    notifyListeners();
    return;
  }
  pendingWrite = true;
  scheduleLedgerFlush();
  window.dispatchEvent(new Event(USAGE_LEDGER_CHANGED_EVENT));
  notifyListeners();
}

/**
 * A copy of the ledger for one mutation to write into.
 *
 * Every mutator replaces the session and day records it changes rather than
 * editing them (`recordSessionTokens`, `addSessionWorkedMs`, `addDailyTokens`,
 * `sessionFromSource` all build new ones), so copying the two maps they write
 * into is enough; the untouched records are shared with the previous ledger,
 * which nothing edits either. A deep clone of every record ran on each usage
 * update, prompt completion and idle transition.
 */
function draftLedger(ledger: UsageLedger): UsageLedger {
  return {
    ...ledger,
    sessions: { ...ledger.sessions },
    daily: { ...ledger.daily },
  };
}

function mutateLedger(mutator: (draft: UsageLedger) => void): void {
  const draft = draftLedger(readLedger());
  mutator(draft);
  writeLedger(draft);
}

function touchFirstEvent(ledger: UsageLedger, timestamp: number): void {
  if (!ledger.firstEventAt || timestamp < ledger.firstEventAt) {
    ledger.firstEventAt = timestamp;
  }
}

function addDailyTokens(
  ledger: UsageLedger,
  day: string,
  delta: {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheTokens?: number;
    providerId?: string;
  },
): void {
  const current = ledger.daily[day] ?? emptyDailyRecord();
  const providerId = delta.providerId;
  const totalDelta = delta.totalTokens ?? 0;
  ledger.daily[day] = {
    totalTokens: current.totalTokens + totalDelta,
    inputTokens: current.inputTokens + (delta.inputTokens ?? 0),
    outputTokens: current.outputTokens + (delta.outputTokens ?? 0),
    cacheTokens: current.cacheTokens + (delta.cacheTokens ?? 0),
    byProvider: {
      ...current.byProvider,
      ...(providerId && totalDelta
        ? {
            [providerId]: (current.byProvider[providerId] ?? 0) + totalDelta,
          }
        : {}),
    },
  };
}

function sessionFromSource(
  existing: UsageSessionRecord | undefined,
  source: UsageSessionSource,
): UsageSessionRecord {
  const createdAt =
    parseTimestamp(source.createdAt) ?? existing?.createdAt ?? Date.now();
  const lastActivityAt =
    parseTimestamp(source.lastMessageAt) ??
    parseTimestamp(source.updatedAt) ??
    existing?.lastActivityAt ??
    createdAt;
  const effort = normalizeEffort(source.effort) ?? existing?.effort;
  return {
    ...(existing ?? emptySessionRecord()),
    providerId: source.providerId || existing?.providerId || DEFAULT_HARNESS_ID,
    modelId: source.modelId ?? existing?.modelId ?? null,
    modelName: source.modelName ?? existing?.modelName ?? null,
    ...(effort ? { effort } : {}),
    createdAt:
      existing?.createdAt && existing.createdAt > 0
        ? existing.createdAt
        : createdAt,
    lastActivityAt: Math.max(existing?.lastActivityAt ?? 0, lastActivityAt),
    messageCount: Math.max(existing?.messageCount ?? 0, source.messageCount),
    started:
      (existing?.started ?? false) ||
      source.started === true ||
      source.messageCount > 0,
  };
}

export function getUsageLedger(): UsageLedger {
  return readLedger();
}

function sameSessionRecord(
  left: UsageSessionRecord,
  right: UsageSessionRecord,
): boolean {
  const leftFields = left as unknown as Record<string, unknown>;
  const rightFields = right as unknown as Record<string, unknown>;
  const keys = Object.keys(leftFields);
  if (keys.length !== Object.keys(rightFields).length) return false;
  return keys.every((key) => Object.is(leftFields[key], rightFields[key]));
}

export function syncUsageSessions(
  sources: readonly UsageSessionSource[],
): void {
  if (sources.length === 0) return;
  // The stats page syncs the whole session list whenever it changes, and a
  // streaming reply changes it every second. Most of those passes find every
  // record already as it would be written, and writing anyway re-stamped and
  // re-saved the ledger (half a megabyte) for nothing.
  const ledger = readLedger();
  const changed = new Map<string, UsageSessionRecord>();
  let firstEventAt = ledger.firstEventAt;
  for (const source of sources) {
    const existing = changed.get(source.id) ?? ledger.sessions[source.id];
    const next = sessionFromSource(existing, source);
    if (!existing || !sameSessionRecord(existing, next)) {
      changed.set(source.id, next);
    }
    if (
      next.createdAt > 0 &&
      (!firstEventAt || next.createdAt < firstEventAt)
    ) {
      firstEventAt = next.createdAt;
    }
  }
  if (changed.size === 0 && firstEventAt === ledger.firstEventAt) return;
  mutateLedger((draft) => {
    for (const [id, next] of changed) {
      draft.sessions[id] = next;
    }
    if (firstEventAt) touchFirstEvent(draft, firstEventAt);
  });
}

export function recordSessionTokens(
  sessionId: string,
  snapshot: UsageTokenSnapshot,
  meta?: Partial<
    Pick<UsageSessionSource, "providerId" | "modelId" | "modelName" | "effort">
  >,
  now = Date.now(),
): void {
  mutateLedger((ledger) => {
    const current = ledger.sessions[sessionId] ?? emptySessionRecord();
    const next = { ...current };
    if (meta?.providerId) next.providerId = meta.providerId;
    if (meta?.modelId !== undefined) next.modelId = meta.modelId;
    if (meta?.modelName !== undefined) next.modelName = meta.modelName;
    const effort = normalizeEffort(meta?.effort);
    if (effort) next.effort = effort;
    if (next.createdAt <= 0) next.createdAt = now;
    next.lastActivityAt = Math.max(next.lastActivityAt, now);
    next.started = true;

    const previousInput = next.inputTokens;
    const previousOutput = next.outputTokens;
    const previousCache = next.cacheTokens;
    const previousTotal = next.totalTokens;
    // An auto snapshot that reports a turn (turnsDelta) is that turn's usage
    // (ACP PromptResponse.usage), so it always adds. Treating it as a
    // cumulative counter whenever both figures grew kept only the larger
    // turn: 100/50 then 200/60 ended at 260 tokens instead of 410.
    const add =
      snapshot.mode === "add" ||
      (snapshot.mode !== "replace" &&
        ((snapshot.turnsDelta ?? 0) > 0 ||
          (snapshot.inputTokens != null &&
            snapshot.outputTokens != null &&
            (snapshot.inputTokens < next.inputTokens ||
              snapshot.outputTokens < next.outputTokens))));

    if (snapshot.inputTokens !== undefined) {
      next.inputTokens = add
        ? next.inputTokens + snapshot.inputTokens
        : Math.max(next.inputTokens, snapshot.inputTokens);
    }
    if (snapshot.outputTokens !== undefined) {
      next.outputTokens = add
        ? next.outputTokens + snapshot.outputTokens
        : Math.max(next.outputTokens, snapshot.outputTokens);
    }
    if (snapshot.cacheTokens !== undefined) {
      next.cacheTokens = add
        ? next.cacheTokens + snapshot.cacheTokens
        : Math.max(next.cacheTokens, snapshot.cacheTokens);
    }

    if (add) {
      if (snapshot.totalTokens != null) {
        next.totalTokens += snapshot.totalTokens;
      } else if (
        snapshot.inputTokens !== undefined ||
        snapshot.outputTokens !== undefined ||
        snapshot.cacheTokens !== undefined
      ) {
        next.totalTokens =
          next.inputTokens + next.outputTokens + next.cacheTokens;
      }
    } else {
      const inferredTotal =
        snapshot.totalTokens ??
        (snapshot.inputTokens !== undefined ||
        snapshot.outputTokens !== undefined
          ? next.inputTokens + next.outputTokens + next.cacheTokens
          : undefined);
      if (inferredTotal !== undefined) {
        next.totalTokens = Math.max(next.totalTokens, inferredTotal);
      }
    }

    if (snapshot.costUsd !== undefined) {
      // A bridge that reports credits or EUR must not have its amounts added
      // to a USD running total: a changed currency replaces the cost instead.
      const currency =
        snapshot.costCurrency === undefined
          ? next.costCurrency
          : normalizeCostCurrency(snapshot.costCurrency);
      const mixesCurrencies =
        next.costUsd != null && currency !== next.costCurrency;
      next.costUsd =
        add && !mixesCurrencies
          ? (next.costUsd ?? 0) + (snapshot.costUsd ?? 0)
          : snapshot.costUsd;
      next.costCurrency = currency;
    }
    if (snapshot.turnsDelta) {
      next.turns += Math.max(0, snapshot.turnsDelta);
    }

    ledger.sessions[sessionId] = next;
    touchFirstEvent(ledger, next.createdAt || now);

    addDailyTokens(ledger, formatLocalDay(new Date(now)), {
      inputTokens: Math.max(0, next.inputTokens - previousInput),
      outputTokens: Math.max(0, next.outputTokens - previousOutput),
      cacheTokens: Math.max(0, next.cacheTokens - previousCache),
      totalTokens: Math.max(0, next.totalTokens - previousTotal),
      providerId: next.providerId,
    });
  });
}

/** Reconcile sealed benchmark evidence. Replaying the same snapshot adds nothing. */
export function projectBenchmarkUsage(record: {
  sessionId: string;
  providerId: string;
  modelId: string;
  effort: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  finishedAt: number;
}): void {
  const current = getUsageLedger().sessions[record.sessionId];
  const input = record.inputTokens ?? current?.inputTokens;
  const output = record.outputTokens ?? current?.outputTokens;
  if (
    current?.origin === "benchmark" &&
    current.inputTokens === (input ?? 0) &&
    current.outputTokens === (output ?? 0) &&
    current.costUsd === record.costUsd &&
    current.workedMs === (record.durationMs ?? 0)
  )
    return;
  recordSessionTokens(
    record.sessionId,
    {
      mode: "replace",
      inputTokens: input,
      outputTokens: output,
      ...(input !== undefined && output !== undefined
        ? { totalTokens: input + output }
        : {}),
      costUsd: record.costUsd,
      costCurrency: "USD",
    },
    {
      providerId: record.providerId,
      modelId: record.modelId,
      effort: record.effort,
    },
    record.finishedAt,
  );
  mutateLedger((ledger) => {
    const row = ledger.sessions[record.sessionId];
    if (!row) return;
    ledger.sessions[record.sessionId] = {
      ...row,
      origin: "benchmark",
      turns: 1,
      workedMs: record.durationMs ?? row.workedMs,
    };
  });
}

export function addSessionWorkedMs(
  sessionId: string,
  ms: number,
  now = Date.now(),
): void {
  if (ms <= 0) return;
  mutateLedger((ledger) => {
    const current = ledger.sessions[sessionId] ?? emptySessionRecord();
    const next = {
      ...current,
      workedMs: current.workedMs + ms,
      lastActivityAt: Math.max(current.lastActivityAt, now),
      started: true,
    };
    if (next.createdAt <= 0) next.createdAt = now;
    ledger.sessions[sessionId] = next;
    touchFirstEvent(ledger, next.createdAt);
  });
}

export function noteSessionWorkState(
  sessionId: string,
  chatState: ChatState,
  now = Date.now(),
): void {
  const isWorking = WORKING_CHAT_STATES.has(chatState);
  const startedAt = workStartedAtBySession.get(sessionId);
  if (isWorking) {
    if (startedAt == null) {
      workStartedAtBySession.set(sessionId, now);
    }
    return;
  }
  if (startedAt == null) return;
  workStartedAtBySession.delete(sessionId);
  addSessionWorkedMs(sessionId, now - startedAt, now);
}

export function getInProgressWorkMs(now = Date.now()): number {
  let total = 0;
  for (const startedAt of workStartedAtBySession.values()) {
    total += Math.max(0, now - startedAt);
  }
  return total;
}

export function remapSessionWorkState(fromId: string, toId: string): void {
  if (!fromId || !toId || fromId === toId) return;
  const startedAt = workStartedAtBySession.get(fromId);
  if (startedAt == null) return;
  workStartedAtBySession.delete(fromId);
  if (!workStartedAtBySession.has(toId)) {
    workStartedAtBySession.set(toId, startedAt);
  }
}

const WORKING_RUN_STATUSES = new Set(["starting", "running", "waiting"]);

export function noteConductorRunStatus(
  sessionId: string,
  status: string,
  now = Date.now(),
): void {
  noteSessionWorkState(
    sessionId,
    WORKING_RUN_STATUSES.has(status) ? "thinking" : "idle",
    now,
  );
}

export function buildUsageSummary(
  extraAgentIds: ReadonlySet<string> = new Set(),
  now = Date.now(),
): UsageSummary {
  const ledger = readLedger();
  const startedIds = new Set<string>();
  let chatsStarted = 0;
  let workedMs = getInProgressWorkMs(now);

  for (const [id, session] of Object.entries(ledger.sessions)) {
    if (
      session.started ||
      session.messageCount > 0 ||
      session.totalTokens > 0
    ) {
      startedIds.add(id);
      chatsStarted += 1;
    }
    workedMs += session.workedMs;
  }
  for (const id of extraAgentIds) {
    startedIds.add(id);
  }

  // Sessions pruned from the ledger only survive as per-provider totals, so
  // their counts are added instead of their ids.
  let archivedChatsStarted = 0;
  for (const record of Object.values(ledger.archived ?? {})) {
    archivedChatsStarted += record.chatsStarted;
    workedMs += record.workedMs;
  }
  chatsStarted += archivedChatsStarted;

  return {
    agentsSpawned: startedIds.size + archivedChatsStarted,
    chatsStarted,
    workedMs,
    firstEventAt: ledger.firstEventAt,
  };
}

/**
 * Folds this window's pending ledger onto the copy another window just wrote.
 *
 * The detached session window is a real feature, so two windows really do write
 * this key, and neither "flush ours over theirs" nor "drop ours for theirs" is
 * right: one loses their delta, the other loses ours. A merge is possible
 * because the two windows own different things:
 *
 * - **sessions** are keyed by session id and a chat lives in exactly one
 *   window, so the record that saw more activity is the real one. Exact.
 * - **archived** records are produced by the same deterministic prune over the
 *   same sessions, so the one that folded more sessions is the later one.
 * - **daily** rows are running totals with no per-window ownership, and without
 *   a common ancestor to diff against there is nothing exact to do: per-field
 *   max keeps the larger of the two. Two windows adding tokens on the same day
 *   can therefore undercount by the smaller delta — far better than losing a
 *   window's whole write, and the session records the page mostly reads from
 *   are exact.
 */
export function mergeUsageLedgers(
  stored: UsageLedger,
  pending: UsageLedger,
): UsageLedger {
  const sessions: Record<string, UsageSessionRecord> = { ...stored.sessions };
  for (const [id, mine] of Object.entries(pending.sessions)) {
    const theirs = sessions[id];
    sessions[id] = theirs && sessionIsNewer(theirs, mine) ? theirs : mine;
  }

  const daily: Record<string, UsageDailyRecord> = { ...stored.daily };
  for (const [day, mine] of Object.entries(pending.daily)) {
    const theirs = daily[day];
    daily[day] = theirs ? mergeDailyRecords(theirs, mine) : mine;
  }

  const archivedEntries = new Map<string, UsageArchivedRecord>(
    Object.entries(stored.archived ?? {}),
  );
  for (const [providerId, mine] of Object.entries(pending.archived ?? {})) {
    const theirs = archivedEntries.get(providerId);
    archivedEntries.set(
      providerId,
      theirs && theirs.sessions >= mine.sessions ? theirs : mine,
    );
  }

  return {
    version: USAGE_LEDGER_VERSION,
    firstEventAt: minDefined(stored.firstEventAt, pending.firstEventAt),
    lastUpdatedAt: maxDefined(stored.lastUpdatedAt, pending.lastUpdatedAt),
    sessions,
    daily,
    ...(archivedEntries.size > 0
      ? { archived: Object.fromEntries(archivedEntries) }
      : {}),
  };
}

/** Which of two copies of one session saw more of it. */
function sessionIsNewer(
  left: UsageSessionRecord,
  right: UsageSessionRecord,
): boolean {
  if (left.lastActivityAt !== right.lastActivityAt) {
    return left.lastActivityAt > right.lastActivityAt;
  }
  if (left.totalTokens !== right.totalTokens) {
    return left.totalTokens > right.totalTokens;
  }
  return left.messageCount > right.messageCount;
}

function mergeDailyRecords(
  left: UsageDailyRecord,
  right: UsageDailyRecord,
): UsageDailyRecord {
  const byProvider: Record<string, number> = { ...left.byProvider };
  for (const [providerId, tokens] of Object.entries(right.byProvider)) {
    byProvider[providerId] = Math.max(byProvider[providerId] ?? 0, tokens);
  }
  return {
    totalTokens: Math.max(left.totalTokens, right.totalTokens),
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    cacheTokens: Math.max(left.cacheTokens, right.cacheTokens),
    byProvider,
  };
}

function minDefined(left: number | null, right: number | null): number | null {
  if (left == null) return right;
  if (right == null) return left;
  return Math.min(left, right);
}

function maxDefined(left: number | null, right: number | null): number | null {
  if (left == null) return right;
  if (right == null) return left;
  return Math.max(left, right);
}

/** Parses the stored ledger without touching the module's cache. */
function readStoredLedger(): UsageLedger | null {
  if (nativeReady) return nativeStoredLedger;
  try {
    const stored = window.localStorage.getItem(USAGE_LEDGER_STORAGE_KEY);
    if (!stored) return null;
    return parseLedger(JSON.parse(stored) as unknown);
  } catch {
    return null;
  }
}

function handleStorageChange(event: StorageEvent): void {
  if (event.key !== USAGE_LEDGER_STORAGE_KEY && event.key !== null) {
    return;
  }
  // Nothing of ours is waiting: adopt the stored copy, as before.
  if (!pendingWrite || !cachedLedger) {
    cachedLedger = null;
    cachedSerialized = null;
    notifyListeners();
    return;
  }
  // Both windows have something. Flushing ours first would overwrite the write
  // that fired this event; dropping ours would lose the debounced mutation. The
  // merge keeps both, and the pending write carries it to the other window.
  // That write keeps its debounce: flushing here at once made two busy windows
  // answer each other's write with a write of their own, back to back.
  const stored = readStoredLedger();
  if (stored) {
    cachedLedger = mergeUsageLedgers(stored, cachedLedger);
  }
  cachedSerialized = null;
  scheduleLedgerFlush();
  notifyListeners();
}

/**
 * Subscribes to ledger changes, including another window's write.
 *
 * Exported as well as used by {@link useUsageLedger} so a test can install the
 * `storage` listener without mounting a component.
 */
export function subscribeUsageLedger(onStoreChange: () => void): () => void {
  return subscribe(onStoreChange);
}

function subscribe(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.add(onStoreChange);
  if (!removeWindowListener) {
    window.addEventListener(USAGE_LEDGER_CHANGED_EVENT, notifyListeners);
    window.addEventListener("storage", handleStorageChange);
    removeWindowListener = () => {
      window.removeEventListener(USAGE_LEDGER_CHANGED_EVENT, notifyListeners);
      window.removeEventListener("storage", handleStorageChange);
    };
  }
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) {
      removeWindowListener?.();
      removeWindowListener = undefined;
    }
  };
}

export function useUsageLedger(): UsageLedger {
  return useSyncExternalStore(subscribe, getUsageLedger, () => EMPTY_LEDGER);
}

export function resetUsageLedgerForTests(): void {
  nativeReady = false;
  nativeStoredLedger = null;
  workStartedAtBySession.clear();
  if (writeTimer != null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  pendingWrite = false;
  storageWriteWarned = false;
  removeFlushListeners?.();
  removeFlushListeners = undefined;
  cachedLedger = cloneLedger(EMPTY_LEDGER);
  cachedSerialized = null;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(USAGE_LEDGER_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  notifyListeners();
}
