import { describe, expect, it } from "vitest";
import {
  accountStatusIsStale,
  canUseAccountReset,
  earliestAccountReset,
  resetCountdown,
} from "./providerAccountStatus";
import type {
  ProviderAccount,
  ProviderAccountStatus,
} from "../api/providerAccounts";

const now = 1_800_000_000_000;
const account: ProviderAccount = {
  id: "first",
  providerId: "codex-acp",
  label: "First",
  authMethod: "oauth",
  enabled: true,
  autoSwitch: true,
  createdAt: now,
  updatedAt: now,
};
const status: ProviderAccountStatus = {
  accountId: "first",
  providerId: "codex-acp",
  state: "ready",
  subscription: null,
  accountLabel: null,
  limits: [],
  resetTokens: null,
  credits: null,
  lastUpdatedAt: now,
  lastAttemptAt: now,
  stale: false,
  error: null,
};

describe("provider account status", () => {
  it("waits for all exhausted windows, ignores healthy windows, and excludes unknown resets", () => {
    const limit = (
      id: string,
      usedPercent: number,
      resetsAt: number | null,
    ) => ({
      id,
      label: id,
      usedPercent,
      remaining: null,
      resetsAt,
      modelId: null,
    });
    const limited = {
      ...status,
      state: "limited" as const,
      limits: [
        limit("session", 100, now + 3600_000),
        limit("weekly", 100, now + 86400_000),
        limit("healthy", 4, now + 1000),
      ],
    };
    expect(earliestAccountReset([account], { first: limited }, now)).toBe(
      now + 86400_000,
    );
    expect(
      earliestAccountReset(
        [account],
        {
          first: {
            ...limited,
            limits: [...limited.limits, limit("unknown", 100, null)],
          },
        },
        now,
      ),
    ).toBeNull();
    expect(
      earliestAccountReset(
        [account],
        {
          first: {
            ...limited,
            limits: [
              {
                ...limit("model-only", 100, now + 1000),
                modelId: "limited-model",
              },
            ],
          },
        },
        now,
      ),
    ).toBeNull();
  });
  it("never turns missing inventory into permission to spend a reset token", () => {
    expect(canUseAccountReset(status, now)).toBe(false);
    expect(
      canUseAccountReset(
        {
          ...status,
          resetTokens: { available: 3, supported: false, expiresAt: null },
        },
        now,
      ),
    ).toBe(false);
  });

  it("requires fresh supported unexpired inventory for an aggregate reset count", () => {
    const available = {
      ...status,
      resetTokens: { available: 1, supported: true, expiresAt: now + 1000 },
    };
    expect(canUseAccountReset(available, now)).toBe(true);
    expect(canUseAccountReset({ ...available, stale: true }, now)).toBe(false);
    expect(canUseAccountReset({ ...available, state: "error" }, now)).toBe(
      false,
    );
    expect(canUseAccountReset(available, now + 1001)).toBe(false);
    expect(accountStatusIsStale(status, now + 120_001)).toBe(true);
  });

  it("checks individual reset expiry without letting an old grant hide a usable one", () => {
    const credit = {
      id: "old",
      resetType: "full",
      status: "available",
      grantedAt: null,
      expiresAt: now - 1,
      title: "Full reset",
      description: null,
    };
    const available: ProviderAccountStatus = {
      ...status,
      resetTokens: {
        available: 1,
        supported: true,
        expiresAt: now - 1,
        credits: [credit, { ...credit, id: "current", expiresAt: now + 1000 }],
      },
    };
    expect(canUseAccountReset(available, now)).toBe(true);
    expect(canUseAccountReset(available, now + 1000)).toBe(false);
    expect(canUseAccountReset({ ...available, state: "needs_auth" }, now)).toBe(
      false,
    );
    expect(canUseAccountReset({ ...available, stale: true }, now)).toBe(true);
    expect(
      canUseAccountReset({ ...available, state: "error", stale: true }, now),
    ).toBe(true);
    for (const state of ["needs_auth", "disabled", "unknown"] as const)
      expect(canUseAccountReset({ ...available, state }, now)).toBe(false);
    expect(
      canUseAccountReset(
        {
          ...available,
          resetTokens: {
            available: 1,
            supported: true,
            expiresAt: now + 1000,
            credits: [{ ...credit, id: "", expiresAt: now + 1000 }],
          },
        },
        now,
      ),
    ).toBe(false);
  });

  it("does not describe an unknown or stale account as exhausted", () => {
    const limited = {
      ...status,
      state: "limited" as const,
      limits: [
        {
          id: "session",
          label: "5 hours",
          usedPercent: 100,
          remaining: 0,
          resetsAt: now + 3600_000,
          modelId: null,
        },
      ],
    };
    expect(earliestAccountReset([account], { first: limited }, now)).toBe(
      now + 3600_000,
    );
    expect(
      earliestAccountReset(
        [account],
        { first: { ...limited, stale: true } },
        now,
      ),
    ).toBeNull();
    expect(
      earliestAccountReset(
        [account, { ...account, id: "unknown" }],
        { first: limited },
        now,
      ),
    ).toBeNull();
  });

  it("rounds the countdown upward and never renders a negative reset", () => {
    expect(resetCountdown(now + 3_660_001, now)).toEqual({
      hours: 1,
      minutes: 2,
    });
    expect(resetCountdown(now - 1000, now)).toEqual({ hours: 0, minutes: 0 });
  });
});
