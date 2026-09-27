/**
 * The ledger on the desktop, where it lives in a document and the native store
 * announces every write to every window — the one that made it included.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageLedger } from "../usageTypes";

const LEDGER_PATH = "state/usage-ledger.json";

const native = vi.hoisted(() => ({
  disk: null as string | null,
  writes: [] as string[],
  onChanged: null as ((event: { payload: string }) => void) | null,
}));

vi.mock("@/shared/api/distillStore", () => ({
  isDesktopRuntime: () => true,
  readDistillDocument: vi.fn(async () => native.disk),
  writeDistillDocument: vi.fn(async (_path: string, contents: string) => {
    native.disk = contents;
    native.writes.push(contents);
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (_name: string, handler: (event: { payload: string }) => void) => {
      native.onChanged = handler;
      return () => {};
    },
  ),
}));

/** The notice the native store sends after any window writes the ledger. */
async function announceWrite(): Promise<void> {
  native.onChanged?.({ payload: LEDGER_PATH });
  await vi.advanceTimersByTimeAsync(0);
}

function otherWindowLedger(): UsageLedger {
  const now = Date.now();
  return {
    version: 1,
    firstEventAt: now - 1_000,
    lastUpdatedAt: now,
    sessions: {
      theirs: {
        providerId: "claude-acp",
        modelId: null,
        modelName: null,
        createdAt: now - 1_000,
        lastActivityAt: now,
        messageCount: 1,
        started: true,
        inputTokens: 99,
        outputTokens: 0,
        cacheTokens: 0,
        totalTokens: 99,
        costUsd: null,
        costCurrency: null,
        turns: 1,
        workedMs: 0,
      },
    },
    daily: {},
  };
}

describe("usage ledger change notices on the desktop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    native.disk = null;
    native.writes = [];
    native.onChanged = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function hydratedLedger() {
    const ledger = await import("../usageLedger");
    await ledger.initializeUsageLedger();
    expect(native.onChanged).not.toBeNull();
    return ledger;
  }

  it("ignores the notice of its own write, even with a change pending", async () => {
    const ledger = await hydratedLedger();
    ledger.recordSessionTokens("ours", { mode: "add", totalTokens: 10 });
    ledger.flushUsageLedger();
    await vi.advanceTimersByTimeAsync(0);
    expect(native.writes).toHaveLength(1);

    // A usage update lands before the notice of that write comes back.
    ledger.recordSessionTokens("ours", { mode: "add", totalTokens: 5 });
    const pending = ledger.getUsageLedger();
    await announceWrite();

    // No merge of our own copy and no write straight back: before, this is
    // where a busy window started writing half a megabyte in a loop.
    expect(ledger.getUsageLedger()).toBe(pending);
    expect(native.writes).toHaveLength(1);

    // The pending change is still written on its own schedule.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(native.writes).toHaveLength(2);
    const stored = JSON.parse(native.writes[1] ?? "{}") as UsageLedger;
    expect(stored.sessions.ours?.totalTokens).toBe(15);
  });

  it("adopts another window's write when nothing of its own is pending", async () => {
    const ledger = await hydratedLedger();
    ledger.recordSessionTokens("ours", { mode: "add", totalTokens: 10 });
    ledger.flushUsageLedger();
    await vi.advanceTimersByTimeAsync(0);

    native.disk = JSON.stringify(otherWindowLedger());
    await announceWrite();

    expect(ledger.getUsageLedger().sessions.theirs?.totalTokens).toBe(99);
    expect(native.writes).toHaveLength(1);
  });

  it("merges another window's write into a pending change and writes it on the debounce", async () => {
    const ledger = await hydratedLedger();
    ledger.recordSessionTokens("ours", { mode: "add", totalTokens: 10 });

    native.disk = JSON.stringify(otherWindowLedger());
    await announceWrite();

    const merged = ledger.getUsageLedger();
    expect(merged.sessions.theirs?.totalTokens).toBe(99);
    expect(merged.sessions.ours?.totalTokens).toBe(10);
    expect(native.writes).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(native.writes).toHaveLength(1);
    const stored = JSON.parse(native.writes[0] ?? "{}") as UsageLedger;
    expect(stored.sessions.theirs?.totalTokens).toBe(99);
    expect(stored.sessions.ours?.totalTokens).toBe(10);

    // And that write's own notice does not start another round.
    await announceWrite();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(native.writes).toHaveLength(1);
  });
});
