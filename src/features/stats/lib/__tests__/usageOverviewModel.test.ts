import { describe, expect, it } from "vitest";
import { buildUsageOverview } from "../usageOverviewModel";
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
      createdAt: Date.parse("2026-08-01T12:00:00"),
      lastActivityAt: Date.parse("2026-08-01T12:00:00"),
      messageCount: 3,
      started: true,
      inputTokens: 80,
      outputTokens: 20,
      cacheTokens: 100,
      totalTokens: 200,
      costUsd: 1.5,
      costCurrency: null,
      turns: 3,
      workedMs: 0,
    },
    b: {
      providerId: "claude-acp",
      modelId: "opus",
      modelName: "Opus",
      createdAt: Date.parse("2026-08-02T12:00:00"),
      lastActivityAt: Date.parse("2026-08-02T12:00:00"),
      messageCount: 1,
      started: true,
      inputTokens: 10,
      outputTokens: 5,
      cacheTokens: 0,
      totalTokens: 15,
      costUsd: null,
      costCurrency: null,
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

  it("flags partial cost when a costed provider has uncosted sessions", () => {
    const { a } = ledger.sessions;
    const overview = buildUsageOverview({
      ledger: {
        ...ledger,
        sessions: {
          a,
          c: { ...a, costUsd: null, totalTokens: 50 },
        },
      },
      enabledProviderIds: ["goose"],
    });

    expect(overview.estimatedCostUsd).toBe(1.5);
    expect(overview.hasPartialCost).toBe(true);
  });

  it("counts the totals of sessions that aged out of the ledger", () => {
    const overview = buildUsageOverview({
      ledger: {
        ...ledger,
        archived: {
          goose: {
            sessions: 4,
            chatsStarted: 4,
            messageCount: 8,
            turns: 6,
            inputTokens: 40,
            outputTokens: 20,
            cacheTokens: 40,
            totalTokens: 100,
            costUsd: 0.5,
            costCurrency: null,
            workedMs: 1_000,
            activeDays: 3,
          },
        },
      },
      enabledProviderIds: ["goose", "claude-acp"],
    });

    const goose = overview.providers.find(
      (provider) => provider.id === "goose",
    );
    expect(goose?.sessions).toBe(5);
    expect(goose?.totalTokens).toBe(300);
    expect(goose?.activeDays).toBe(4);
    expect(overview.totalTokens).toBe(315);
    expect(overview.estimatedCostUsd).toBe(2);
  });
  it("does not add up costs a provider reported in different currencies", () => {
    const { a } = ledger.sessions;
    const overview = buildUsageOverview({
      ledger: {
        ...ledger,
        sessions: {
          a,
          credits: { ...a, costUsd: 200, costCurrency: "CREDITS" },
        },
      },
      enabledProviderIds: ["goose"],
    });

    const goose = overview.providers.find(
      (provider) => provider.id === "goose",
    );
    expect(goose?.estimatedCostUsd).toBeNull();
    expect(overview.estimatedCostUsd).toBeNull();
    expect(overview.hasPartialCost).toBe(true);
  });

  it("reads an archived fold that dropped a cost as partial", () => {
    // Past the 90-day prune a mixed-currency provider's dropped amounts are
    // gone from the record. The figure that is left is real but short, and a
    // confident "$" total that omits the EUR sessions is the failure.
    const overview = buildUsageOverview({
      ledger: {
        ...ledger,
        sessions: {},
        archived: {
          goose: {
            sessions: 4,
            chatsStarted: 4,
            messageCount: 8,
            turns: 6,
            inputTokens: 40,
            outputTokens: 20,
            cacheTokens: 40,
            totalTokens: 100,
            costUsd: 0.5,
            costCurrency: "USD",
            hasMissingCost: true,
            workedMs: 1_000,
            activeDays: 3,
          },
        },
      },
      enabledProviderIds: ["goose"],
    });

    expect(overview.hasPartialCost).toBe(true);
    // The known part is still reported; it is the completeness that is flagged.
    expect(overview.estimatedCostUsd).toBe(0.5);
  });

  it("keeps a single non-USD currency on the figure it belongs to", () => {
    const { a } = ledger.sessions;
    const overview = buildUsageOverview({
      ledger: {
        ...ledger,
        sessions: { a: { ...a, costUsd: 12, costCurrency: "EUR" } },
      },
      enabledProviderIds: ["goose"],
    });

    expect(overview.estimatedCostUsd).toBe(12);
    expect(overview.costCurrency).toBe("EUR");
    expect(
      overview.providers.find((provider) => provider.id === "goose")
        ?.costCurrency,
    ).toBe("EUR");
  });
});
