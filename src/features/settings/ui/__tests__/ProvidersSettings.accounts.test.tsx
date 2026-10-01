import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useProviderAccountsStore } from "@/features/providers/stores/providerAccountsStore";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useProviderRateLimitsStore } from "@/features/status/stores/providerRateLimitsStore";
import { CURATED_PROVIDER_CATALOG_BY_ID } from "@/features/providers/curatedProviders";
import { ProvidersSettings } from "../ProvidersSettings";

const mocks = vi.hoisted(() => ({ rerun: vi.fn(), refresh: vi.fn() }));
vi.mock("@/shared/api/useDoctorReport", () => ({
  rerunDoctorReport: mocks.rerun,
  useDoctorReport: () => ({ isFetching: false }),
  useDoctorReportFreshnessFetching: () => false,
}));
vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    agentReadiness: new Map([
      ["codex-acp", "not_installed"],
      ["claude-acp", "ready"],
      ["grok-acp", "ready"],
      ["kimi-acp", "ready"],
    ]),
    agentChecks: new Map(),
    loading: false,
    statusUnavailable: false,
  }),
}));
vi.mock(
  "@/features/providers/stores/providerAccountsStore",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/features/providers/stores/providerAccountsStore")
    >()),
    startProviderAccountsMonitor: vi.fn(),
  }),
);
vi.mock("../RoutingPolicySection", () => ({
  RoutingPolicySection: () => null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  useProviderCatalogStore.setState({
    entries: ["codex-acp", "claude-acp", "grok-acp", "kimi-acp"].flatMap(
      (id) => {
        const entry = CURATED_PROVIDER_CATALOG_BY_ID.get(id);
        return entry ? [entry] : [];
      },
    ),
  });
  useProviderAccountsStore.setState({
    accounts: [],
    defaults: {},
    automaticSwitching: {},
    loaded: true,
    refreshing: false,
    error: null,
    refresh: mocks.refresh,
    statuses: {},
  });
  useProviderRateLimitsStore.setState({
    snapshot: null,
    fetchedAtByProvider: {},
    isRefreshing: false,
  });
});

it("uses the same provider sections and usage rows for Grok and Kimi", () => {
  const checkedAt = Date.now();
  useProviderRateLimitsStore.setState({
    fetchedAtByProvider: { "kimi-acp": checkedAt },
    snapshot: {
      updatedAt: checkedAt,
      providers: ["grok-acp", "kimi-acp"].map((provider) => ({
        provider,
        configured: true,
        status: "ok",
        error: null,
        updatedAt: checkedAt,
        accountLabel: `${provider}@example.test`,
        planType: "Reported plan",
        session: null,
        monthly: null,
        weekly: {
          usedPercent: 23,
          windowMinutes: 10_080,
          resetsAt: null,
          resetDescription: null,
        },
        credits:
          provider === "kimi-acp"
            ? [
                {
                  id: "extra_usage",
                  label: "Extra usage",
                  balance: "7.5",
                  total: "20",
                  currency: "USD",
                  expiresAt: null,
                  unlimited: false,
                },
              ]
            : null,
      })),
    },
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProvidersSettings />
    </QueryClientProvider>,
  );
  const panel = screen.getByRole("region", { name: "Accounts and limits" });
  for (const name of ["Codex", "Claude Code", "Grok", "Kimi Code"]) {
    expect(within(panel).getAllByRole("region", { name })).toHaveLength(1);
  }
  for (const name of ["Grok", "Kimi Code"]) {
    const section = within(panel).getByRole("region", { name });
    expect(within(section).getByText("Weekly")).toBeInTheDocument();
    expect(within(section).getByText("23% used")).toBeInTheDocument();
    expect(
      within(section).getByText("Plan: Reported plan"),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole("button", { name: `Sign out of ${name}` }),
    ).toBeInTheDocument();
    expect(within(section).queryByRole("switch")).toBeNull();
    expect(within(section).queryByText(/Reset tokens/)).toBeNull();
  }
  expect(
    screen.getByText("Extra usage: $7.50 of $20.00 left"),
  ).toBeInTheDocument();
  expect(screen.queryByText("Other providers")).toBeNull();
  expect(screen.getAllByText(/^Last checked/)).toHaveLength(1);
  expect(screen.getByText(/^Last checked/)).toHaveAttribute(
    "datetime",
    new Date(checkedAt).toISOString(),
  );
});

it("shows each managed provider once with setup inside its account group", () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProvidersSettings />
    </QueryClientProvider>,
  );
  expect(
    screen.getAllByText("Codex", { selector: ":not(title)" }),
  ).toHaveLength(1);
  expect(
    screen.getAllByText("Claude Code", { selector: ":not(title)" }),
  ).toHaveLength(1);
  const codex = screen.getByRole("region", { name: "Codex" });
  expect(
    within(codex).getByRole("button", { name: "Install Codex" }),
  ).toBeInTheDocument();
  expect(within(codex).getByRole("switch")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Sign out of Claude Code" }),
  ).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Refresh" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(mocks.refresh).toHaveBeenCalledWith(true);
  expect(mocks.rerun).toHaveBeenCalled();
});
