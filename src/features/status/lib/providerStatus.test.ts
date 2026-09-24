import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { DoctorReport } from "@/shared/api/doctor";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import {
  getAgentProviders,
  providerDisplayName,
} from "@/features/providers/providerCatalog";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { readinessFromReport } from "@/features/providers/hooks/useAgentProviderStatus";
import { buildUsageOverview } from "@/features/stats/lib/usageOverviewModel";
import {
  syncUsageSessions,
  recordSessionTokens,
  getUsageLedger,
  resetUsageLedgerForTests,
} from "@/features/stats/lib/usageLedger";
import { buildProviderStatuses } from "./providerStatus";
import {
  isListedUsageProvider,
  platformLimitState,
  getUsageSections,
} from "./rateLimitWindows";
import { getProviderUsageStatusKind } from "./rateLimitFormatters";
import { canConnectPlatform } from "./connectPlatforms";
import { ProviderSegment } from "../ui/ProviderSegment";
import {
  parseAgentRankingSource,
  rankingInventoryFromProviders,
} from "@/features/agents/lib/agentModelRanking";

const future: ProviderCatalogEntry = {
  id: "future-acp",
  displayName: "Future Provider",
  category: "agent",
  description: "Test provider",
  setupMethod: "cli_auth",
  group: "default",
  aliases: ["future"],
  supportsAuth: true,
  supportsAuthStatus: true,
  supportsInstall: true,
};

afterEach(() => {
  useProviderCatalogStore.getState().reset();
  resetUsageLedgerForTests();
});

describe("catalog provider participation", () => {
  it.each([
    future,
    { ...future, id: "kimi-acp", displayName: "Kimi Code", aliases: ["kimi"] },
  ])("includes $displayName in status, setup, names, and recorded history without a usage adapter", (entry) => {
    useProviderCatalogStore.getState().setEntries([entry]);
    const readiness = readinessFromReport({
      checks: [
        {
          id: `ai-agent-${entry.aliases?.[0]}`,
          status: "pass",
          path: "test-cli",
          authStatus: "authenticated",
        },
      ],
    } as DoctorReport);
    expect(readiness.get(entry.id)).toBe("ready");
    expect(getAgentProviders()).toEqual([entry]);
    expect(
      parseAgentRankingSource(
        JSON.stringify({
          entries: [
            { platform: entry.id, modelId: "live-model", label: "Live model" },
          ],
        }),
      )?.kind,
    ).toBe("list");
    expect(
      rankingInventoryFromProviders(
        [{ id: entry.id, label: entry.displayName }],
        () => [{ id: "live-model" }],
      )[0]?.platform,
    ).toBe(entry.id);
    expect(canConnectPlatform(entry.id, "not_installed")).toBe(true);
    expect(canConnectPlatform(entry.id, "not_ready")).toBe(true);
    const [status] = buildProviderStatuses(getAgentProviders(), [], readiness);
    expect(status.configured).toBe(true);
    expect(isListedUsageProvider(status, true)).toBe(true);
    expect(getProviderUsageStatusKind(status)).toBe("ok");
    expect(providerDisplayName(status.provider)).toBe(entry.displayName);
    const html = renderToStaticMarkup(
      createElement(ProviderSegment, { provider: status }),
    );
    expect(html).toContain("Connected");
    expect(html).not.toContain("Sign in");
    expect(html).not.toContain("data-usage-bar");

    const date = new Date().toISOString();
    syncUsageSessions([
      {
        id: "catalog-chat",
        providerId: entry.id,
        modelId: "live-model",
        createdAt: date,
        updatedAt: date,
        messageCount: 2,
      },
    ]);
    recordSessionTokens("catalog-chat", {
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
    });
    const ledger = getUsageLedger();
    expect(ledger.sessions["catalog-chat"].providerId).toBe(entry.id);
    const overview = buildUsageOverview({
      ledger,
      enabledProviderIds: [entry.id],
    });
    expect(overview.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: entry.id,
          label: entry.displayName,
          totalTokens: 125,
        }),
      ]),
    );
  });

  it("keeps signed-out and missing providers distinct without requiring a quota adapter", () => {
    const [signedOut] = buildProviderStatuses(
      [future],
      [],
      new Map([[future.id, "not_ready"]]),
    );
    expect(getProviderUsageStatusKind(signedOut)).toBe("sign-in");
    expect(isListedUsageProvider(signedOut, true)).toBe(true);
    const [missing] = buildProviderStatuses(
      [future],
      [],
      new Map([[future.id, "not_installed"]]),
    );
    expect(isListedUsageProvider(missing, false)).toBe(false);
    expect(buildProviderStatuses([future], [], new Map())[0].status).toBe(
      "idle",
    );
  });

  it("uses monthly coding constraints alongside shorter Kimi quota windows", () => {
    const window = {
      usedPercent: 20,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null,
    };
    const [usage] = buildProviderStatuses(
      [future],
      [
        {
          provider: future.id,
          session: window,
          weekly: window,
          monthly: { ...window, usedPercent: 80, windowMinutes: 43200 },
          codingMonthly: { ...window, usedPercent: 100, windowMinutes: 43200 },
          status: "ok",
          configured: true,
          error: null,
          updatedAt: 1,
        },
      ],
      new Map([[future.id, "ready"]]),
    );
    expect(getUsageSections(usage).map((section) => section.key)).toEqual([
      "session",
      "weekly",
      "monthly",
      "codingMonthly",
    ]);
    expect(platformLimitState([usage], future.id)).toBe("at-limit");
    const [signedOut] = buildProviderStatuses(
      [future],
      [usage],
      new Map([[future.id, "not_ready"]]),
    );
    expect(getUsageSections(signedOut)).toEqual([]);
    expect(getProviderUsageStatusKind(signedOut)).toBe("sign-in");
  });
});
