import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderAccount,
  ProviderAccountStatus,
} from "@/features/providers/api/providerAccounts";
import { useProviderAccountsStore } from "@/features/providers/stores/providerAccountsStore";
import type { ProviderRateLimits } from "../lib/rateLimitTypes";

const startMonitor = vi.hoisted(() => vi.fn());
vi.mock("@/features/providers/stores/providerAccountsStore", async (load) => ({
  ...(await load<
    typeof import("@/features/providers/stores/providerAccountsStore")
  >()),
  startProviderAccountsMonitor: startMonitor,
}));

import {
  keepUnchangedProviders,
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

function account(id: string, providerId = "codex-acp"): ProviderAccount {
  return {
    id,
    providerId,
    label: id,
    authMethod: "oauth",
    enabled: true,
    autoSwitch: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function status(
  accountId: string,
  overrides: Partial<ProviderAccountStatus> = {},
): ProviderAccountStatus {
  return {
    accountId,
    providerId: "codex-acp",
    state: "ready",
    subscription: "Pro",
    accountLabel: null,
    limits: [
      {
        id: "session",
        label: "Session",
        usedPercent: 12,
        remaining: null,
        resetsAt: 1,
        windowMinutes: 300,
        modelId: null,
      },
    ],
    resetTokens: null,
    credits: null,
    lastUpdatedAt: 1,
    lastAttemptAt: 1,
    stale: false,
    error: null,
    ...overrides,
  };
}

describe("keepUnchangedProviders", () => {
  it("keeps the previous array when only the read time moved", () => {
    const previous = [usage(), usage({ provider: "claude-acp" })];
    const next = [
      usage({ updatedAt: 2 }),
      usage({ provider: "claude-acp", updatedAt: 2 }),
    ];

    const kept = keepUnchangedProviders(previous, next);

    expect(kept).toBe(previous);
    // Kept objects are never written to; the read time lives in the store.
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
});

describe("the status-bar view of the account model", () => {
  beforeEach(() => {
    startMonitor.mockReset();
    useProviderAccountsStore.setState({
      accounts: [],
      defaults: {},
      statuses: {},
      error: null,
    });
    useProviderRateLimitsStore.setState({
      snapshot: null,
      fetchedAtByProvider: {},
      isRefreshing: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists every provider's default account from one model and starts the account monitor", () => {
    useProviderAccountsStore.setState({
      accounts: [account("one"), account("cli-login-grok-acp", "grok-acp")],
      defaults: { "codex-acp": "one", "grok-acp": "cli-login-grok-acp" },
      statuses: {
        one: status("one"),
        "cli-login-grok-acp": status("cli-login-grok-acp", {
          providerId: "grok-acp",
          subscription: "SuperGrok",
          limits: [
            {
              id: "grok:weekly",
              label: "Weekly",
              usedPercent: 57,
              remaining: null,
              resetsAt: 5,
              windowMinutes: 10_080,
              modelId: null,
            },
          ],
          lastAttemptAt: 7,
        }),
      },
    });
    const stop = startProviderRateLimitPolling();
    try {
      expect(startMonitor).toHaveBeenCalledTimes(1);
      const providers =
        useProviderRateLimitsStore.getState().snapshot?.providers ?? [];
      expect(providers.map((provider) => provider.provider)).toEqual([
        "codex-acp",
        "grok-acp",
      ]);
      const grok = providers[1];
      expect(grok.accountId).toBe("cli-login-grok-acp");
      expect(grok.planType).toBe("SuperGrok");
      expect(grok.weekly?.usedPercent).toBe(57);
      expect(grok.session).toBeNull();
      expect(
        useProviderRateLimitsStore.getState().fetchedAtByProvider["grok-acp"],
      ).toBe(7);
    } finally {
      stop();
    }
  });

  it("keeps the snapshot when a status read brings back the same usage", () => {
    useProviderAccountsStore.setState({
      accounts: [account("one")],
      defaults: { "codex-acp": "one" },
      statuses: { one: status("one") },
    });
    const stop = startProviderRateLimitPolling();
    try {
      const first = useProviderRateLimitsStore.getState().snapshot;
      expect(first).not.toBeNull();
      useProviderAccountsStore.setState({
        statuses: { one: status("one", { lastAttemptAt: 9 }) },
      });
      const second = useProviderRateLimitsStore.getState().snapshot;
      expect(second).toBe(first);
      // The details panel's "updated … ago" still follows the latest read.
      expect(
        useProviderRateLimitsStore.getState().fetchedAtByProvider["codex-acp"],
      ).toBe(9);
    } finally {
      stop();
    }
  });

  it("switches account data immediately when the default changes", () => {
    useProviderAccountsStore.setState({
      accounts: [account("one"), account("two")],
      defaults: { "codex-acp": "one" },
    });
    const stop = startProviderRateLimitPolling();
    try {
      expect(
        useProviderRateLimitsStore.getState().snapshot?.providers[0].accountId,
      ).toBe("one");
      useProviderAccountsStore.setState({ defaults: { "codex-acp": "two" } });
      expect(
        useProviderRateLimitsStore.getState().snapshot?.providers[0].accountId,
      ).toBe("two");
    } finally {
      stop();
    }
  });

  it("stops following the accounts once polling stops", () => {
    useProviderAccountsStore.setState({
      accounts: [account("one")],
      defaults: { "codex-acp": "one" },
    });
    const stop = startProviderRateLimitPolling();
    stop();
    useProviderAccountsStore.setState({ defaults: {} });
    expect(
      useProviderRateLimitsStore.getState().snapshot?.providers,
    ).toHaveLength(1);
  });

  it("keeps manual refresh busy until the forced account read finishes", async () => {
    let finish!: () => void;
    const refresh = vi
      .spyOn(useProviderAccountsStore.getState(), "refresh")
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
    const pending = useProviderRateLimitsStore.getState().refresh();
    const duplicate = useProviderRateLimitsStore.getState().refresh();
    await Promise.resolve();
    expect(useProviderRateLimitsStore.getState().isRefreshing).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(true);
    finish();
    await Promise.all([pending, duplicate]);
    expect(useProviderRateLimitsStore.getState().isRefreshing).toBe(false);
  });

  it("surfaces the account read's error on the view", async () => {
    vi.spyOn(useProviderAccountsStore.getState(), "refresh").mockImplementation(
      async () => {
        useProviderAccountsStore.setState({ error: "Offline" });
      },
    );
    await useProviderRateLimitsStore.getState().load();
    expect(useProviderRateLimitsStore.getState().error).toBe("Offline");
    expect(useProviderRateLimitsStore.getState().isRefreshing).toBe(false);
  });
});
