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

  it("offers an operator reset only from a fresh supported unexpired inventory", () => {
    const available = {
      ...status,
      resetTokens: { available: 1, supported: true, expiresAt: now + 1000 },
    };
    expect(canUseAccountReset(available, now)).toBe(true);
    expect(canUseAccountReset({ ...available, stale: true }, now)).toBe(false);
    expect(canUseAccountReset(available, now + 1001)).toBe(false);
    expect(accountStatusIsStale(status, now + 120_001)).toBe(true);
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
