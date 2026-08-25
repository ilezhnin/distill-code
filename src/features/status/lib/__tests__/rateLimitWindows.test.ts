import { describe, expect, it } from "vitest";
import type { ProviderRateLimits } from "../rateLimitTypes";
import {
  clampUsedPercent,
  formatDuration,
  getTightestUsageSection,
  getUsageSections,
  isProviderVisible,
  platformLimitState,
  providerMaxUsed,
} from "../rateLimitWindows";

function limits(
  overrides: Partial<ProviderRateLimits> = {},
): ProviderRateLimits {
  return {
    provider: "claude-acp",
    session: {
      usedPercent: 32,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null,
    },
    weekly: {
      usedPercent: 16,
      windowMinutes: 10080,
      resetsAt: null,
      resetDescription: null,
    },
    fableWeekly: {
      usedPercent: 42,
      windowMinutes: 10080,
      resetsAt: null,
      resetDescription: null,
    },
    updatedAt: 1,
    error: null,
    status: "ok",
    configured: true,
    ...overrides,
  };
}

describe("rateLimitWindows", () => {
  it("clamps percents", () => {
    expect(clampUsedPercent(140)).toBe(100);
    expect(clampUsedPercent(-2)).toBe(0);
  });

  it("picks the tightest window including Fable", () => {
    const tightest = getTightestUsageSection(limits());
    expect(tightest?.key).toBe("fableWeekly");
    expect(providerMaxUsed(limits())).toBe(42);
  });

  it("hides unconfigured unavailable providers", () => {
    expect(
      isProviderVisible(
        limits({
          configured: false,
          status: "unavailable",
          session: null,
          weekly: null,
          fableWeekly: null,
        }),
      ),
    ).toBe(false);
  });

  it("keeps configured providers visible without usage data", () => {
    expect(
      isProviderVisible(
        limits({
          status: "error",
          session: null,
          weekly: null,
          fableWeekly: null,
          error: "RPC process exited unexpectedly",
        }),
      ),
    ).toBe(true);
    expect(
      getUsageSections(
        limits({ session: null, weekly: null, fableWeekly: null }),
      ),
    ).toEqual([]);
  });

  it("formats remaining durations", () => {
    expect(formatDuration(0)).toBe("now");
    expect(formatDuration(90 * 60 * 1000)).toBe("1h 30m");
    expect(formatDuration(5 * 24 * 60 * 60 * 1000 + 17 * 60 * 60 * 1000)).toBe(
      "5d 17h",
    );
  });

  describe("platformLimitState", () => {
    const window = (usedPercent: number) => ({
      usedPercent,
      windowMinutes: 10080,
      resetsAt: null,
      resetDescription: null,
    });

    it("ignores a window scoped to another model", () => {
      // Fable's weekly allowance is spent; the account's own windows are not.
      const providers = [
        limits({
          session: window(10),
          weekly: window(20),
          fableWeekly: window(100),
        }),
      ];

      expect(platformLimitState(providers, "claude-acp")).toBe("clear");
      expect(
        platformLimitState(providers, "claude-acp", {
          scopedWindow: "fableWeekly",
        }),
      ).toBe("at-limit");
    });

    it("reports a shared window that is spent for every model on it", () => {
      const providers = [limits({ session: window(100), weekly: window(20) })];

      expect(platformLimitState(providers, "claude-acp")).toBe("at-limit");
      expect(
        platformLimitState(providers, "claude-acp", {
          scopedWindow: "fableWeekly",
        }),
      ).toBe("at-limit");
    });

    it("calls a nearly-full window near-limit, not clear", () => {
      const providers = [limits({ session: window(93), weekly: window(20) })];

      expect(platformLimitState(providers, "claude-acp")).toBe("near-limit");
      expect(
        platformLimitState(providers, "claude-acp", { nearLimitPercent: 95 }),
      ).toBe("clear");
    });

    it("treats an unknown platform as clear", () => {
      expect(platformLimitState([], "grok-acp")).toBe("clear");
    });
  });
});
