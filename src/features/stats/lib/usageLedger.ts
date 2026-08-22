import { useSyncExternalStore } from "react";
import type { ChatState } from "@/shared/types/chat";
import { formatLocalDay, parseTimestamp } from "./usageFormatters";
import type {
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

const workStartedAtBySession = new Map<string, number>();
const listeners = new Set<() => void>();

let cachedLedger: UsageLedger | null = null;
let cachedSerialized: string | null = null;
let removeWindowListener: (() => void) | undefined;

function emptySessionRecord(): UsageSessionRecord {
  return {
    providerId: "goose",
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
  };
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

  return {
    version: USAGE_LEDGER_VERSION,
    firstEventAt: asNonNegativeInt(parsed.firstEventAt),
    lastUpdatedAt: asNonNegativeInt(parsed.lastUpdatedAt),
    sessions,
    daily,
  };
}

function readLedger(): UsageLedger {
  if (typeof window === "undefined") {
    return cloneLedger(EMPTY_LEDGER);
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
  try {
    const serialized = JSON.stringify(stamped);
    cachedSerialized = serialized;
    window.localStorage.setItem(USAGE_LEDGER_STORAGE_KEY, serialized);
  } catch {
    // localStorage can be unavailable in restricted contexts.
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
    providerId: source.providerId || existing?.providerId || "goose",
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
    const add =
      snapshot.mode === "add" ||
      (snapshot.mode !== "replace" &&
        snapshot.inputTokens != null &&
        snapshot.outputTokens != null &&
        (snapshot.inputTokens < next.inputTokens ||
          snapshot.outputTokens < next.outputTokens));

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
        next.totalTokens = next.inputTokens + next.outputTokens + next.cacheTokens;
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
      next.costUsd = add
        ? (next.costUsd ?? 0) + (snapshot.costUsd ?? 0)
        : snapshot.costUsd;
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

  return {
    agentsSpawned: startedIds.size,
    chatsStarted,
    workedMs,
    firstEventAt: ledger.firstEventAt,
  };
}

function handleStorageChange(event: StorageEvent): void {
  if (event.key !== USAGE_LEDGER_STORAGE_KEY && event.key !== null) {
    return;
  }
  cachedLedger = null;
  cachedSerialized = null;
  notifyListeners();
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
