import { afterEach, describe, expect, it } from "vitest";
import {
  addSessionWorkedMs,
  buildUsageSummary,
  getUsageLedger,
  noteSessionWorkState,
  recordSessionTokens,
  resetUsageLedgerForTests,
  syncUsageSessions,
} from "../usageLedger";
import { USAGE_LEDGER_STORAGE_KEY } from "../usageTypes";

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

    const stored = window.localStorage.getItem(USAGE_LEDGER_STORAGE_KEY);
    expect(stored).toContain('"s1"');
  });

  it("keeps token totals monotonic on replace and adds on add", () => {
    recordSessionTokens("s1", {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    recordSessionTokens("s1", {
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
