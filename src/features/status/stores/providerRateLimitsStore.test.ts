import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderRateLimitSnapshot,
  ProviderRateLimits,
} from "../lib/rateLimitTypes";

const fetchSnapshot = vi.hoisted(() =>
  vi.fn<() => Promise<ProviderRateLimitSnapshot>>(),
);
vi.mock("../api/providerRateLimits", () => ({
  getProviderRateLimits: fetchSnapshot,
}));

import {
  keepUnchangedProviders,
  mergeStale,
  startProviderRateLimitPolling,
  useProviderRateLimitsStore,
} from "./providerRateLimitsStore";

function usage(
  overrides: Partial<ProviderRateLimits> = {},
): ProviderRateLimits {
  return {
    provider: "codex-acp",
    session: {
      usedPercent: 12,
      windowMinutes: 300,
      resetsAt: 1,
      resetDescription: null,
    },
    weekly: null,
    monthly: null,
    accountLabel: null,
    updatedAt: 1,
    error: null,
    status: "ok",
    configured: true,
    ...overrides,
  };
}

describe("mergeStale", () => {
  it("drops cached windows when the next fetch is an expired sign-in", () => {
    const previous = [usage()];
    const next = [
      usage({
        session: null,
        status: "error",
        configured: false,
        error: "Codex usage request unauthorized (HTTP 401): token_revoked",
      }),
    ];

    expect(mergeStale(previous, next)[0].session).toBeNull();
    expect(mergeStale(previous, next)[0].configured).toBe(false);
  });

  it("keeps cached windows across a configured refresh failure", () => {
    const previous = [usage()];
    const next = [
      usage({
        session: null,
        status: "error",
        configured: true,
        error: "Codex usage request failed (HTTP 500)",
      }),
    ];

    expect(mergeStale(previous, next)[0].session).toEqual(previous[0].session);
  });
});

describe("keepUnchangedProviders", () => {
  it("keeps the previous array when only the fetch time moved", () => {
    const previous = [usage(), usage({ provider: "claude-acp" })];
    const next = [
      usage({ updatedAt: 2 }),
      usage({ provider: "claude-acp", updatedAt: 2 }),
    ];

    const kept = keepUnchangedProviders(previous, next);

    expect(kept).toBe(previous);
    // Kept objects are never written to; the fetch time lives in the store.
    expect(kept.map((provider) => provider.updatedAt)).toEqual([1, 1]);
  });

  it("replaces only the provider whose usage changed", () => {
    const previous = [usage(), usage({ provider: "claude-acp" })];
    const changed = usage({
      provider: "claude-acp",
      updatedAt: 2,
      session: {
        usedPercent: 40,
        windowMinutes: 300,
        resetsAt: 1,
        resetDescription: null,
      },
    });

    const kept = keepUnchangedProviders(previous, [
      usage({ updatedAt: 2 }),
      changed,
    ]);

    expect(kept).not.toBe(previous);
    expect(kept[0]).toBe(previous[0]);
    expect(kept[1]).toBe(changed);
  });

  it("treats a stale window carried over by mergeStale as unchanged", () => {
    const previous = [usage()];
    const failed = [
      usage({
        session: null,
        status: "error",
        configured: true,
        error: "Codex usage request failed (HTTP 500)",
        updatedAt: 2,
      }),
    ];
    const first = keepUnchangedProviders(
      previous,
      mergeStale(previous, failed),
    );
    const second = keepUnchangedProviders(
      first,
      mergeStale(first, [{ ...failed[0], updatedAt: 3 }]),
    );

    expect(second).toBe(first);
    expect(second[0]?.session).toEqual(previous[0]?.session);
  });
});

describe("provider rate limit polling", () => {
  const POLL_MS = 2 * 60 * 1000;
  let hidden = false;

  function snapshot(updatedAt: number): ProviderRateLimitSnapshot {
    return { providers: [usage({ updatedAt })], updatedAt };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
    fetchSnapshot.mockReset();
    fetchSnapshot.mockImplementation(async () => snapshot(Date.now()));
    useProviderRateLimitsStore.setState({
      snapshot: null,
      fetchedAtByProvider: {},
      isRefreshing: false,
      error: null,
    });
  });

  afterEach(() => {
    // The own property shadows jsdom's getter on the prototype; dropping it
    // restores the real value for the next test.
    Reflect.deleteProperty(document, "hidden");
    vi.useRealTimers();
  });

  it("keeps the snapshot a poll with the same usage brings back", async () => {
    const stop = startProviderRateLimitPolling();
    try {
      await vi.advanceTimersByTimeAsync(0);
      const first = useProviderRateLimitsStore.getState().snapshot;
      expect(first).not.toBeNull();

      await vi.advanceTimersByTimeAsync(POLL_MS);

      expect(fetchSnapshot).toHaveBeenCalledTimes(2);
      const second = useProviderRateLimitsStore.getState().snapshot;
      expect(second).toBe(first);
      // The details panel's "updated … ago" still follows the latest fetch.
      const [provider] = second?.providers ?? [];
      expect(
        useProviderRateLimitsStore.getState().fetchedAtByProvider[
          provider?.provider ?? ""
        ],
      ).toBe(Date.now());
    } finally {
      stop();
    }
  });

  it("skips polls while hidden and catches up once visible again", async () => {
    const stop = startProviderRateLimitPolling();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSnapshot).toHaveBeenCalledTimes(1);

      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(3 * POLL_MS);
      expect(fetchSnapshot).toHaveBeenCalledTimes(1);

      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it("does not fetch again on becoming visible when the last fetch is fresh", async () => {
    const stop = startProviderRateLimitPolling();
    try {
      await vi.advanceTimersByTimeAsync(0);
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(POLL_MS / 4);

      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  it("stops listening for visibility once polling stops", async () => {
    const stop = startProviderRateLimitPolling();
    await vi.advanceTimersByTimeAsync(0);
    stop();

    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });
});
