import { describe, expect, it } from "vitest";
import type { ProviderAccountStatus } from "@/features/providers/api/providerAccounts";
import { accountUsage } from "./accountUsage";
import {
  getProviderUsageStatusKind,
  usageRetrySeconds,
} from "./rateLimitFormatters";
import { getUsageSections, platformLimitState } from "./rateLimitWindows";

function project(patch: Partial<ProviderAccountStatus> = {}) {
  return accountUsage({
    accounts: [
      {
        id: "one",
        providerId: "claude-acp",
        label: "Account",
        authMethod: "oauth",
        enabled: true,
        autoSwitch: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    defaults: { "claude-acp": "one" },
    automaticSwitching: {},
    statuses: {
      one: {
        accountId: "one",
        providerId: "claude-acp",
        state: "ready",
        subscription: "Max",
        accountLabel: "Test",
        resetTokens: null,
        credits: null,
        lastUpdatedAt: 10,
        lastAttemptAt: 11,
        stale: false,
        error: null,
        limits: [
          {
            id: "weekly:0",
            label: "Weekly",
            usedPercent: 30,
            remaining: 70,
            resetsAt: 100,
            modelId: null,
            windowMinutes: 10_080,
          },
          {
            id: "session:1",
            label: "Session",
            usedPercent: 10,
            remaining: 90,
            resetsAt: 20,
            modelId: null,
            windowMinutes: 300,
          },
          {
            id: "weekly_scoped:2",
            label: "Fable",
            usedPercent: 100,
            remaining: 0,
            resetsAt: 100,
            modelId: "fable",
            windowMinutes: 10_080,
          },
        ],
        ...patch,
      },
    },
  });
}

describe("account usage projection", () => {
  it("uses duration, preserves model scope and the selected identity", () => {
    const [usage] = project();
    expect(usage.accountId).toBe("one");
    expect(usage.session?.usedPercent).toBe(10);
    expect(usage.weekly?.usedPercent).toBe(30);
    expect(usage.fableWeekly?.usedPercent).toBe(100);
    expect(platformLimitState([usage], "claude-acp")).toBe("clear");
    expect(
      platformLimitState([usage], "claude-acp", {
        scopedWindow: "fableWeekly",
      }),
    ).toBe("at-limit");
  });

  it("clears windows after authorization is lost", () => {
    const [usage] = project({ state: "needs_auth" });
    expect(usage.session).toBeNull();
    expect(getProviderUsageStatusKind(usage)).toBe("sign-in");
  });

  it("preserves cached quota without reporting sign-in or exhaustion during a 429", () => {
    const [usage] = project({
      state: "error",
      stale: true,
      error:
        "Claude usage is temporarily rate limited. Try again in 60 seconds.",
    });
    expect(usage.configured).toBe(true);
    expect(usage.session?.usedPercent).toBe(10);
    expect(usage.weekly?.usedPercent).toBe(30);
    expect(getProviderUsageStatusKind(usage)).toBe("refresh-failed");
    expect(platformLimitState([usage], "claude-acp")).not.toBe("at-limit");
  });

  it("reports a provider pause as paused with a live countdown, not a failed refresh", () => {
    const [usage] = project({
      state: "error",
      stale: true,
      error: "Claude usage requests are paused by the provider.",
      usageRetryAt: 100_000,
    });
    expect(getProviderUsageStatusKind(usage)).toBe("paused");
    expect(usageRetrySeconds(usage, 10_000)).toBe(90);
    expect(usageRetrySeconds(usage, 99_001)).toBe(1);
    expect(usageRetrySeconds(usage, 200_000)).toBe(0);
    expect(usageRetrySeconds({ usageRetryAt: null }, 0)).toBeNull();
    expect(platformLimitState([usage], "claude-acp")).not.toBe("at-limit");
  });

  it("retains a separate spending block with no known duration", () => {
    const [usage] = project({ state: "limited", limits: [] });
    expect(getProviderUsageStatusKind(usage)).toBe("limited");
    expect(platformLimitState([usage], "claude-acp")).toBe("at-limit");
  });

  it.each([
    28, 30, 31,
  ])("preserves a reported %i-day monthly allowance", (days) => {
    const [usage] = project({
      limits: [
        {
          id: "primary",
          label: "opaque provider name",
          usedPercent: 74,
          remaining: 26,
          resetsAt: 123456,
          windowMinutes: days * 24 * 60,
          modelId: null,
        },
      ],
    });
    expect(getUsageSections(usage)).toEqual([
      expect.objectContaining({
        key: "monthly",
        label: "monthly",
        window: expect.objectContaining({
          usedPercent: 74,
          resetsAt: 123456,
          windowMinutes: days * 24 * 60,
        }),
      }),
    ]);
  });

  it("does not invent a five-hour allowance for a weekly-only account", () => {
    const [usage] = project({
      limits: [
        {
          id: "codex:primary",
          label: "codex · 10080 min",
          usedPercent: 8,
          remaining: 92,
          resetsAt: 123456,
          windowMinutes: 10080,
          modelId: null,
        },
      ],
    });
    expect(getUsageSections(usage).map((section) => section.key)).toEqual([
      "weekly",
    ]);
  });

  it("does not infer a period from a technical label or reset date", () => {
    const [usage] = project({
      limits: [
        {
          id: "unknown",
          label: "weekly_all",
          usedPercent: 8,
          remaining: 92,
          resetsAt: Date.now() + 7 * 86400000,
          windowMinutes: null,
          modelId: null,
        },
      ],
    });
    expect(getUsageSections(usage)).toEqual([]);
  });

  it("retains model-specific periods without treating them as shared account quotas", () => {
    const [usage] = project({
      limits: [300, 10080, 43200].map((minutes) => ({
        id: `model:${minutes}`,
        label: `model · ${minutes} min`,
        usedPercent: 100,
        remaining: 0,
        resetsAt: 123456,
        windowMinutes: minutes,
        modelId: "Test model",
      })),
    });
    const sections = getUsageSections(usage);
    expect(sections.map((section) => section.label)).toEqual([
      "fiveHour",
      "weekly",
      "monthly",
    ]);
    expect(sections.every((section) => section.modelId === "Test model")).toBe(
      true,
    );
    expect(platformLimitState([usage], "claude-acp")).toBe("clear");
    expect(
      platformLimitState([usage], "claude-acp", {
        scopedWindow: sections[0].key,
      }),
    ).toBe("at-limit");
  });
});
