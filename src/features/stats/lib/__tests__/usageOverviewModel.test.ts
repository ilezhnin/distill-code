import { describe, expect, it } from "vitest";
import { buildUsageOverview, getRecentUsageDays } from "../usageOverviewModel";
import type { UsageLedger } from "../usageTypes";

const ledger: UsageLedger = {
  version: 1,
  firstEventAt: 1,
  lastUpdatedAt: 2,
  sessions: {
    a: {
      providerId: "goose",
      modelId: "gpt-5",
      modelName: "GPT-5",
      createdAt: 1,
      lastActivityAt: 1,
      messageCount: 3,
      started: true,
      inputTokens: 80,
      outputTokens: 20,
      cacheTokens: 100,
      totalTokens: 200,
      costUsd: 1.5,
      turns: 3,
      workedMs: 0,
    },
    b: {
      providerId: "claude-acp",
      modelId: "opus",
      modelName: "Opus",
      createdAt: 1,
      lastActivityAt: 1,
      messageCount: 1,
      started: true,
      inputTokens: 10,
      outputTokens: 5,
      cacheTokens: 0,
      totalTokens: 15,
      costUsd: null,
      turns: 0,
      workedMs: 0,
    },
  },
  daily: {
    "2026-08-01": {
      totalTokens: 200,
      inputTokens: 80,
      outputTokens: 20,
      cacheTokens: 100,
      byProvider: { goose: 200 },
    },
    "2026-08-02": {
      totalTokens: 15,
      inputTokens: 10,
      outputTokens: 5,
      cacheTokens: 0,
      byProvider: { "claude-acp": 15 },
    },
  },
};

describe("usageOverviewModel", () => {
  it("aggregates providers, cache share, and partial cost", () => {
    const overview = buildUsageOverview({
      ledger,
      enabledProviderIds: ["goose", "claude-acp"],
    });

    expect(overview.totalTokens).toBe(215);
    expect(overview.cacheShare).toBeCloseTo(100 / 190);
    expect(overview.hasPartialCost).toBe(true);
    expect(overview.estimatedCostUsd).toBe(1.5);
    expect(overview.providers[0]?.id).toBe("goose");
    expect(overview.bestDay?.day).toBe("2026-08-01");
  });

  it("filters daily totals to the selected provider", () => {
    const overview = buildUsageOverview({
      ledger,
      enabledProviderIds: ["goose", "claude-acp"],
      providerFilter: "claude-acp",
    });
    expect(overview.totalTokens).toBe(15);
    expect(
      overview.daily.find((day) => day.day === "2026-08-01")?.totalTokens,
    ).toBe(0);
    expect(
      overview.daily.find((day) => day.day === "2026-08-02")?.totalTokens,
    ).toBe(15);
  });

  it("fills a contiguous recent-day window", () => {
    const days = getRecentUsageDays(
      buildUsageOverview({ ledger }).daily,
      3,
      new Date(2026, 7, 2),
    );
    expect(days.map((day) => day.day)).toEqual([
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ]);
    expect(days[0]?.intensity).toBe(0);
    expect(days[1]?.intensity).toBeGreaterThan(0);
  });
});
