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
/** Detailed session records are kept while they stay this recent. */
const SESSION_RETENTION_MS = 90 * DAY_MS;
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

function emptyArchivedRecord(): UsageArchivedRecord {
  return {
    sessions: 0,
    chatsStarted: 0,
    messageCount: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    costUsd: null,
    costCurrency: null,
    workedMs: 0,
    activeDays: 0,
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
  return {
    providerId: raw.providerId,
    modelId: typeof raw.modelId === "string" ? raw.modelId : null,
    modelName: typeof raw.modelName === "string" ? raw.modelName : null,
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

function foldSessionIntoArchive(
  archived: Map<string, UsageArchivedRecord>,
  session: UsageSessionRecord,
): void {
  const providerId = session.providerId || DEFAULT_HARNESS_ID;
  const current = archived.get(providerId) ?? emptyArchivedRecord();
  const started =
    session.started || session.messageCount > 0 || session.totalTokens > 0;
  const foldsCost =
    current.costUsd == null || current.costCurrency === session.costCurrency;
  // A cost this fold is about to drop. The record keeps one currency, so a
  // provider that reported EUR for a while and USD after loses the EUR
  // amounts here — and `costUsd` would otherwise read as a complete figure.
  const dropsCost = session.costUsd != null && !foldsCost;
  archived.set(providerId, {
    sessions: current.sessions + 1,
    chatsStarted: current.chatsStarted + (started ? 1 : 0),
    messageCount: current.messageCount + session.messageCount,
    turns: current.turns + session.turns,
    inputTokens: current.inputTokens + session.inputTokens,
    outputTokens: current.outputTokens + session.outputTokens,
    cacheTokens: current.cacheTokens + session.cacheTokens,
    totalTokens: current.totalTokens + session.totalTokens,
    // Only same-currency costs are summed; a session in another currency
    // contributes its tokens but not its cost (`costUsd` would be a lie).
    costUsd:
      session.costUsd == null || !foldsCost
        ? current.costUsd
        : (current.costUsd ?? 0) + session.costUsd,
    costCurrency:
      current.costUsd == null && session.costUsd != null && foldsCost
        ? session.costCurrency
        : current.costCurrency,
    ...(current.hasMissingCost || dropsCost ? { hasMissingCost: true } : {}),
    workedMs: current.workedMs + session.workedMs,
    activeDays: current.activeDays,
  });
}

/**
 * Keeps the persisted ledger bounded: detailed session records live for
 * `SESSION_RETENTION_MS` and are then folded into per-provider totals, daily
 * rollups are kept for `DAILY_RETENTION_MS`. Returns the same object when
 * nothing aged out.
 */
function pruneLedger(ledger: UsageLedger, now: number): UsageLedger {
  const sessionCutoff = now - SESSION_RETENTION_MS;
  const dailyCutoff = formatLocalDay(new Date(now - DAILY_RETENTION_MS));

  const archived = new Map<string, UsageArchivedRecord>(
    Object.entries(ledger.archived ?? {}).map(([providerId, record]) => [
      providerId,
      { ...record },
    ]),
  );
  const sessions: Record<string, UsageSessionRecord> = {};
  const prunedDays = new Map<string, Set<string>>();
  let prunedSessions = 0;
  for (const [id, session] of Object.entries(ledger.sessions)) {
    const lastSeenAt = session.lastActivityAt || session.createdAt;
    if (lastSeenAt > 0 && lastSeenAt < sessionCutoff) {
      prunedSessions += 1;
      foldSessionIntoArchive(archived, session);
      const providerId = session.providerId || DEFAULT_HARNESS_ID;
      const days = prunedDays.get(providerId) ?? new Set<string>();
      days.add(formatLocalDay(new Date(lastSeenAt)));
      prunedDays.set(providerId, days);
      continue;
    }
    sessions[id] = session;
  }
  for (const [providerId, days] of prunedDays) {
    const record = archived.get(providerId);
    if (!record) continue;
    // Approximate: days seen in earlier prunes are already counted, and a
    // prune batch only covers sessions that just crossed the retention edge.
    archived.set(providerId, {
      ...record,
      activeDays: record.activeDays + days.size,
    });
  }

  const dailyEntries = Object.entries(ledger.daily).filter(
    ([day]) => day >= dailyCutoff,
  );
  const prunedDaily = dailyEntries.length !== Object.keys(ledger.daily).length;
  if (prunedSessions === 0 && !prunedDaily) return ledger;

  return {
    ...ledger,
    sessions,
    daily: Object.fromEntries(dailyEntries),
    ...(archived.size > 0 ? { archived: Object.fromEntries(archived) } : {}),
  };
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
  installFlushListeners();
  if (writeTimer == null) {
    writeTimer = setTimeout(() => {
      writeTimer = null;
      flushUsageLedger();
    }, LEDGER_WRITE_DEBOUNCE_MS);
  }
  window.dispatchEvent(new Event(USAGE_LEDGER_CHANGED_EVENT));
  notifyListeners();
}

function mutateLedger(mutator: (draft: UsageLedger) => void): void {
  const draft = cloneLedger(readLedger());
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
  return {
    ...(existing ?? emptySessionRecord()),
    providerId: source.providerId || existing?.providerId || DEFAULT_HARNESS_ID,
    modelId: source.modelId ?? existing?.modelId ?? null,
    modelName: source.modelName ?? existing?.modelName ?? null,
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

export function syncUsageSessions(
  sources: readonly UsageSessionSource[],
): void {
  if (sources.length === 0) return;
  mutateLedger((ledger) => {
    for (const source of sources) {
      const next = sessionFromSource(ledger.sessions[source.id], source);
      ledger.sessions[source.id] = next;
      if (next.createdAt > 0) {
        touchFirstEvent(ledger, next.createdAt);
      }
    }
  });
}

export function recordSessionTokens(
  sessionId: string,
  snapshot: UsageTokenSnapshot,
  meta?: Partial<
    Pick<UsageSessionSource, "providerId" | "modelId" | "modelName">
  >,
  now = Date.now(),
): void {
  mutateLedger((ledger) => {
    const current = ledger.sessions[sessionId] ?? emptySessionRecord();
    const next = { ...current };
    if (meta?.providerId) next.providerId = meta.providerId;
    if (meta?.modelId !== undefined) next.modelId = meta.modelId;
    if (meta?.modelName !== undefined) next.modelName = meta.modelName;
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
  // merge keeps both, then writes it so the other window converges too.
  const stored = readStoredLedger();
  if (stored) {
    cachedLedger = mergeUsageLedgers(stored, cachedLedger);
  }
  cachedSerialized = null;
  flushUsageLedger();
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
