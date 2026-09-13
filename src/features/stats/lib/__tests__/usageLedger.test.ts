import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addSessionWorkedMs,
  buildUsageSummary,
  flushUsageLedger,
  getUsageLedger,
  noteSessionWorkState,
  recordSessionTokens,
  resetUsageLedgerForTests,
  syncUsageSessions,
} from "../usageLedger";
import { formatLocalDay } from "../usageFormatters";
import type { UsageLedger } from "../usageTypes";
import { USAGE_LEDGER_STORAGE_KEY } from "../usageTypes";

const DAY_MS = 24 * 60 * 60 * 1000;

function storedLedger(): UsageLedger {
  const raw = window.localStorage.getItem(USAGE_LEDGER_STORAGE_KEY);
  expect(raw).toBeTruthy();
  return JSON.parse(raw ?? "{}") as UsageLedger;
}

describe("usageLedger", () => {
  afterEach(() => {
    resetUsageLedgerForTests();
  });

  it("persists session metadata and token snapshots", () => {
    syncUsageSessions([
      {
        id: "s1",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        lastMessageAt: "2026-08-02T00:00:00.000Z",
        messageCount: 4,
        providerId: "goose",
        modelId: "gpt-5",
        modelName: "GPT-5",
      },
    ]);
    recordSessionTokens("s1", {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      costUsd: 0.42,
    });

    const ledger = getUsageLedger();
    expect(ledger.sessions.s1?.totalTokens).toBe(150);
    expect(ledger.sessions.s1?.costUsd).toBe(0.42);
    expect(ledger.sessions.s1?.modelName).toBe("GPT-5");
    expect(ledger.sessions.s1?.started).toBe(true);

    flushUsageLedger();
    const stored = window.localStorage.getItem(USAGE_LEDGER_STORAGE_KEY);
    expect(stored).toContain('"s1"');
  });

  it("keeps token totals monotonic on replace and adds on add", () => {
    recordSessionTokens("s1", {
      mode: "replace",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    recordSessionTokens("s1", {
      mode: "replace",
      inputTokens: 80,
      outputTokens: 10,
      totalTokens: 90,
    });
    expect(getUsageLedger().sessions.s1?.totalTokens).toBe(120);

    recordSessionTokens("s1", {
      mode: "add",
      inputTokens: 5,
      outputTokens: 5,
      cacheTokens: 10,
      turnsDelta: 1,
    });
    const session = getUsageLedger().sessions.s1;
    expect(session?.inputTokens).toBe(105);
    expect(session?.cacheTokens).toBe(10);
    expect(session?.turns).toBe(1);
  });

  it("tracks work time across working chat states", () => {
    noteSessionWorkState("s1", "thinking", 1_000);
    noteSessionWorkState("s1", "streaming", 1_500);
    noteSessionWorkState("s1", "idle", 4_000);
    expect(getUsageLedger().sessions.s1?.workedMs).toBe(3_000);

    addSessionWorkedMs("s1", 250);
    expect(getUsageLedger().sessions.s1?.workedMs).toBe(3_250);
  });

  it("adds later smaller token snapshots instead of dropping them", () => {
    recordSessionTokens("s1", {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
    recordSessionTokens("s1", {
      inputTokens: 40,
      outputTokens: 10,
      totalTokens: 50,
    });
    expect(getUsageLedger().sessions.s1?.totalTokens).toBe(200);
  });

  it("adds each per-turn snapshot, even one above the running total", () => {
    recordSessionTokens("s1", {
      inputTokens: 100,
      outputTokens: 50,
      cacheTokens: 10,
      totalTokens: 150,
      turnsDelta: 1,
    });
    recordSessionTokens("s1", {
      inputTokens: 200,
      outputTokens: 60,
      cacheTokens: 30,
      totalTokens: 260,
      turnsDelta: 1,
    });
    const session = getUsageLedger().sessions.s1;
    expect(session?.inputTokens).toBe(300);
    expect(session?.outputTokens).toBe(110);
    expect(session?.cacheTokens).toBe(40);
    expect(session?.totalTokens).toBe(410);
    expect(session?.turns).toBe(2);
  });

  it("summarizes started sessions and extra conductor agents", () => {
    syncUsageSessions([
      {
        id: "chat-1",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        messageCount: 2,
        providerId: "goose",
      },
      {
        id: "empty",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        messageCount: 0,
        providerId: "goose",
      },
    ]);
    const summary = buildUsageSummary(new Set(["worker-1", "chat-1"]));
    expect(summary.chatsStarted).toBe(1);
    expect(summary.agentsSpawned).toBe(2);
  });
});

describe("usageLedger persistence", () => {
  afterEach(() => {
    resetUsageLedgerForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("persists a burst of usage events with a single write", () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    recordSessionTokens("s1", {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      turnsDelta: 1,
    });
    recordSessionTokens("s1", {
      mode: "add",
      inputTokens: 10,
      outputTokens: 10,
      totalTokens: 20,
    });
    addSessionWorkedMs("s1", 500);

    expect(setItem).not.toHaveBeenCalled();
    // The in-memory ledger stays authoritative while the write is pending.
    expect(getUsageLedger().sessions.s1?.totalTokens).toBe(170);
    expect(getUsageLedger().sessions.s1?.workedMs).toBe(500);

    vi.advanceTimersByTime(1_000);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(storedLedger().sessions.s1?.totalTokens).toBe(170);
  });

  it("flushes a pending write when the window goes away", () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    addSessionWorkedMs("s1", 1_000);
    expect(setItem).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("pagehide"));
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(storedLedger().sessions.s1?.workedMs).toBe(1_000);
  });

  it("keeps counting in memory and warns once when the write is refused", () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    recordSessionTokens("s1", {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
    vi.advanceTimersByTime(1_000);
    recordSessionTokens("s1", {
      mode: "add",
      inputTokens: 10,
      totalTokens: 10,
    });
    vi.advanceTimersByTime(1_000);

    expect(getUsageLedger().sessions.s1?.totalTokens).toBe(160);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("folds sessions idle for months into provider totals and drops ancient days", () => {
    const now = Date.now();
    const ancientAt = now - 500 * DAY_MS;
    const staleAt = now - 120 * DAY_MS;
    recordSessionTokens(
      "ancient",
      { inputTokens: 10, outputTokens: 5, totalTokens: 15, turnsDelta: 1 },
      { providerId: "goose" },
      ancientAt,
    );
    recordSessionTokens(
      "stale",
      { inputTokens: 20, outputTokens: 10, totalTokens: 30, turnsDelta: 1 },
      { providerId: "goose" },
      staleAt,
    );
    recordSessionTokens(
      "fresh",
      { inputTokens: 1, outputTokens: 1, totalTokens: 2, turnsDelta: 1 },
      { providerId: "goose" },
      now,
    );

    flushUsageLedger();

    const stored = storedLedger();
    expect(Object.keys(stored.sessions)).toEqual(["fresh"]);
    expect(stored.archived?.goose).toMatchObject({
      sessions: 2,
      chatsStarted: 2,
      totalTokens: 45,
      turns: 2,
      activeDays: 2,
    });
    expect(
      Object.keys(stored.daily).includes(formatLocalDay(new Date(ancientAt))),
    ).toBe(false);
    expect(
      Object.keys(stored.daily).includes(formatLocalDay(new Date(staleAt))),
    ).toBe(true);

    // The pruned sessions still count towards the headline numbers.
    expect(buildUsageSummary().chatsStarted).toBe(3);
    expect(buildUsageSummary().agentsSpawned).toBe(3);
  });
});

describe("usageLedger cost currency", () => {
  afterEach(() => {
    resetUsageLedgerForTests();
  });

  it("keeps the reported currency with the cost", () => {
    recordSessionTokens("s1", {
      mode: "add",
      totalTokens: 10,
      costUsd: 1.5,
      costCurrency: "eur",
    });
    recordSessionTokens("s1", {
      mode: "add",
      totalTokens: 10,
      costUsd: 0.5,
      costCurrency: "EUR",
    });

    const session = getUsageLedger().sessions.s1;
    expect(session?.costUsd).toBe(2);
    expect(session?.costCurrency).toBe("EUR");
  });

  it("replaces rather than sums a cost that arrives in another currency", () => {
    recordSessionTokens("s1", {
      mode: "add",
      totalTokens: 10,
      costUsd: 4,
      costCurrency: "USD",
    });
    recordSessionTokens("s1", {
      mode: "add",
      totalTokens: 10,
      costUsd: 120,
      costCurrency: "credits",
    });

    const session = getUsageLedger().sessions.s1;
    expect(session?.costUsd).toBe(120);
    expect(session?.costCurrency).toBe("CREDITS");
  });
});
