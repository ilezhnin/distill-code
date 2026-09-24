import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addSessionWorkedMs,
  flushUsageLedger,
  getUsageLedger,
  mergeUsageLedgers,
  subscribeUsageLedger,
  recordSessionTokens,
  resetUsageLedgerForTests,
  syncUsageSessions,
} from "../usageLedger";
import type { UsageLedger, UsageSessionRecord } from "../usageTypes";
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
});

describe("usageLedger persistence", () => {
  afterEach(() => {
    resetUsageLedgerForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
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
});

describe("two windows writing the same ledger", () => {
  afterEach(() => {
    resetUsageLedgerForTests();
  });

  /** What another window's write looks like to this one. */
  function otherWindowWrites(ledger: UsageLedger): void {
    window.localStorage.setItem(
      USAGE_LEDGER_STORAGE_KEY,
      JSON.stringify(ledger),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: USAGE_LEDGER_STORAGE_KEY }),
    );
  }

  it("merges the other window's session instead of overwriting it", () => {
    // The detached session window is a real feature. Flushing our copy over
    // theirs lost their delta; dropping ours lost the debounced mutation.
    // Sessions are keyed by id and a chat lives in one window, so both survive.
    const unsubscribe = subscribeUsageLedger(() => {});
    try {
      recordSessionTokens(
        "ours",
        { mode: "add", totalTokens: 10, turnsDelta: 1 },
        { providerId: "goose" },
      );
      flushUsageLedger();
      const base = storedLedger();

      // Ours is pending (debounced, not yet flushed)…
      recordSessionTokens("ours", { mode: "add", totalTokens: 5 });
      // …and the other window writes its own chat at the same moment.
      otherWindowWrites({
        ...base,
        sessions: {
          ...base.sessions,
          theirs: {
            ...base.sessions.ours,
            totalTokens: 99,
            inputTokens: 99,
            outputTokens: 0,
          },
        },
      });

      const merged = getUsageLedger();
      expect(merged.sessions.theirs?.totalTokens).toBe(99);
      expect(merged.sessions.ours?.totalTokens).toBe(15);
      // And the merge is persisted, so the other window converges too.
      const stored = storedLedger();
      expect(stored.sessions.theirs?.totalTokens).toBe(99);
      expect(stored.sessions.ours?.totalTokens).toBe(15);
    } finally {
      unsubscribe();
    }
  });
});

describe("mergeUsageLedgers", () => {
  function ledger(over: Partial<UsageLedger> = {}): UsageLedger {
    return {
      version: 1,
      firstEventAt: null,
      lastUpdatedAt: null,
      sessions: {},
      daily: {},
      ...over,
    };
  }

  function session(over: Partial<UsageSessionRecord> = {}): UsageSessionRecord {
    return {
      providerId: "goose",
      modelId: null,
      modelName: null,
      createdAt: 1,
      lastActivityAt: 1,
      messageCount: 0,
      started: true,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      costUsd: null,
      costCurrency: null,
      turns: 0,
      workedMs: 0,
      ...over,
    };
  }

  it("keeps the copy of a session that saw more of it", () => {
    const merged = mergeUsageLedgers(
      ledger({
        sessions: { s1: session({ lastActivityAt: 20, totalTokens: 8 }) },
      }),
      ledger({
        sessions: { s1: session({ lastActivityAt: 10, totalTokens: 3 }) },
      }),
    );

    expect(merged.sessions.s1?.totalTokens).toBe(8);
  });

  it("keeps the larger of two same-day rollups and the earliest first event", () => {
    const merged = mergeUsageLedgers(
      ledger({
        firstEventAt: 50,
        lastUpdatedAt: 80,
        daily: {
          "2026-09-01": {
            totalTokens: 10,
            inputTokens: 6,
            outputTokens: 4,
            cacheTokens: 0,
            byProvider: { goose: 10 },
          },
        },
      }),
      ledger({
        firstEventAt: 20,
        lastUpdatedAt: 90,
        daily: {
          "2026-09-01": {
            totalTokens: 7,
            inputTokens: 7,
            outputTokens: 0,
            cacheTokens: 0,
            byProvider: { goose: 7, claude: 3 },
          },
        },
      }),
    );

    expect(merged.daily["2026-09-01"]).toEqual({
      totalTokens: 10,
      inputTokens: 7,
      outputTokens: 4,
      cacheTokens: 0,
      byProvider: { goose: 10, claude: 3 },
    });
    expect(merged.firstEventAt).toBe(20);
    expect(merged.lastUpdatedAt).toBe(90);
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

  it("marks an archived fold that had to drop a cost as incomplete", () => {
    // A bridge that reported EUR for a while and USD after, both past the
    // 90-day prune: the archived record keeps one currency and silently drops
    // the other amounts, so a "$" total on the Stats page was short with no
    // partial-cost marker anywhere.
    const staleAt = Date.now() - 120 * DAY_MS;
    recordSessionTokens(
      "eur-session",
      { mode: "add", totalTokens: 10, costUsd: 3, costCurrency: "EUR" },
      { providerId: "goose" },
      staleAt,
    );
    recordSessionTokens(
      "usd-session",
      { mode: "add", totalTokens: 10, costUsd: 5, costCurrency: "USD" },
      { providerId: "goose" },
      staleAt,
    );

    flushUsageLedger();

    const archived = storedLedger().archived?.goose;
    expect(archived?.hasMissingCost).toBe(true);
    // The kept figure is one currency's worth, and now says so.
    expect(archived?.costUsd).toBe(3);
    expect(archived?.costCurrency).toBe("EUR");
  });

  it("does not mark a single-currency fold as incomplete", () => {
    const staleAt = Date.now() - 120 * DAY_MS;
    for (const id of ["a", "b"]) {
      recordSessionTokens(
        id,
        { mode: "add", totalTokens: 10, costUsd: 2, costCurrency: "USD" },
        { providerId: "goose" },
        staleAt,
      );
    }

    flushUsageLedger();

    const archived = storedLedger().archived?.goose;
    expect(archived?.costUsd).toBe(4);
    expect(archived?.hasMissingCost).toBeUndefined();
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
