import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import enSettings from "@/shared/i18n/locales/en/settings.json";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  recordSessionTokens,
  resetUsageLedgerForTests,
} from "@/features/stats/lib/usageLedger";
import { StatsSettings } from "../StatsSettings";

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: new Set(["goose"]),
    agentReadiness: new Map([["goose", "ready"]]),
    agentChecks: new Map(),
    loading: false,
    refresh: vi.fn(),
  }),
}));

async function renderStatsSettings() {
  await act(async () => {
    renderWithProviders(<StatsSettings />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("StatsSettings", () => {
  beforeEach(() => {
    resetUsageLedgerForTests();
    useChatStore.setState({
      sessionStateById: {},
    });
    useChatSessionStore.setState({
      sessions: [],
      hasHydratedSessions: true,
      hasMoreSessions: false,
      isLoading: false,
      isLoadingMoreSessions: false,
      loadSessions: vi.fn().mockResolvedValue(undefined),
      loadMoreSessions: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    resetUsageLedgerForTests();
  });

  it("renders the empty tracking state", async () => {
    await renderStatsSettings();

    expect(screen.getByText(enSettings.stats.title)).toBeInTheDocument();
    expect(
      screen.getByText(enSettings.stats.emptyTracking),
    ).toBeInTheDocument();
    expect(
      screen.getByText(enSettings.stats.usageAnalytics),
    ).toBeInTheDocument();
  });

  it("renders summary cards and usage totals from the ledger", async () => {
    recordSessionTokens(
      "s1",
      {
        inputTokens: 1_000,
        outputTokens: 500,
        totalTokens: 1_500,
        costUsd: 2.5,
      },
      { providerId: "goose", modelName: "GPT-5" },
    );

    await renderStatsSettings();

    expect(
      screen.getByText(enSettings.stats.agentsSpawned),
    ).toBeInTheDocument();
    expect(screen.getByText(enSettings.stats.totalTokens)).toBeInTheDocument();
    expect(screen.getAllByText("1.5k").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$2.50").length).toBeGreaterThan(0);
  });
});
