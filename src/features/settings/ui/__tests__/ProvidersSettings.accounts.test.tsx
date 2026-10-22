import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ProviderAccountStatus } from "@/features/providers/api/providerAccounts";
import { useProviderAccountsStore } from "@/features/providers/stores/providerAccountsStore";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useProviderRateLimitsStore } from "@/features/status/stores/providerRateLimitsStore";
import {
  CURATED_PROVIDER_CATALOG,
  CURATED_PROVIDER_CATALOG_BY_ID,
} from "@/features/providers/curatedProviders";
import { providerModelState, providerModels } from "@/test/providerModels";
import { ProvidersSettings } from "../ProvidersSettings";

const mocks = vi.hoisted(() => ({ rerun: vi.fn(), refresh: vi.fn() }));
const readiness = vi.hoisted(
  () =>
    new Map<string, "ready" | "not_installed" | "not_ready">([
      ["codex-acp", "not_installed"],
      ["claude-acp", "ready"],
      ["grok-acp", "ready"],
      ["kimi-acp", "ready"],
      ["zai-acp", "ready"],
      ["copilot-acp", "not_ready"],
      ["amp-acp", "ready"],
    ]),
);
vi.mock("@/shared/api/useDoctorReport", () => ({
  rerunDoctorReport: mocks.rerun,
  useDoctorReport: () => ({ isFetching: false }),
  useDoctorReportFreshnessFetching: () => false,
}));
vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    agentReadiness: readiness,
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

const PROVIDER_IDS = CURATED_PROVIDER_CATALOG.map((entry) => entry.id);

function cliStatus(
  providerId: string,
  overrides: Partial<ProviderAccountStatus>,
): ProviderAccountStatus {
  return {
    accountId: `cli-login-${providerId}`,
    providerId,
    state: "ready",
    subscription: null,
    accountLabel: null,
    limits: [],
    resetTokens: null,
    credits: null,
    lastUpdatedAt: Date.now(),
    lastAttemptAt: Date.now(),
    stale: false,
    error: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useProviderCatalogStore.setState({
    entries: PROVIDER_IDS.flatMap((id) => {
      const entry = CURATED_PROVIDER_CATALOG_BY_ID.get(id);
      return entry ? [entry] : [];
    }),
  });
  useProviderAccountsStore.setState({
    ...providerModelState(providerModels(PROVIDER_IDS, [])),
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

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ProvidersSettings />
    </QueryClientProvider>,
  );
}

it("renders every harness as one card of the same structure", () => {
  const checkedAt = Date.now();
  useProviderAccountsStore.setState({
    statuses: {
      "cli-login-grok-acp": cliStatus("grok-acp", {
        accountLabel: "grok-acp@example.test",
        subscription: "Reported plan",
        lastAttemptAt: checkedAt,
        limits: [
          {
            id: "grok:weekly",
            label: "Weekly",
            usedPercent: 23,
            remaining: null,
            resetsAt: null,
            windowMinutes: 10_080,
            modelId: null,
          },
        ],
      }),
      "cli-login-kimi-acp": cliStatus("kimi-acp", {
        accountLabel: "kimi-acp@example.test",
        subscription: "Reported plan",
        lastAttemptAt: checkedAt - 1,
        limits: [
          {
            id: "kimi:limit7d",
            label: "Weekly",
            usedPercent: 23,
            remaining: null,
            resetsAt: null,
            windowMinutes: 10_080,
            modelId: null,
          },
          {
            id: "kimi:monthCode",
            label: "Monthly coding",
            usedPercent: 87,
            remaining: null,
            resetsAt: null,
            windowMinutes: 43_200,
            modelId: null,
            coding: true,
          },
        ],
        credits: [
          {
            id: "extra_usage",
            label: "Extra usage",
            balance: "7.5",
            total: "20",
            currency: "USD",
            expiresAt: null,
            unlimited: false,
          },
        ],
      }),
    },
  });
  renderPage();
  const panel = screen.getByRole("region", { name: "Accounts and limits" });
  for (const entry of CURATED_PROVIDER_CATALOG) {
    const section = within(panel).getByRole("region", {
      name: entry.displayName,
    });
    // Every card: the harness header, the switch, Add account, and rows.
    expect(
      within(section).getByRole("switch", {
        name: `Auto-switch ${entry.displayName} accounts`,
      }),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole("button", { name: "Add account" }),
    ).toBeInTheDocument();
    expect(
      within(section).queryByRole("button", {
        name: `Sign out of ${entry.displayName}`,
      }),
    ).toBeNull();
    expect(
      within(section).queryByRole("button", {
        name: `Sign in to ${entry.displayName}`,
      }),
    ).toBeNull();
  }
  // Grok and Kimi: the CLI sign-in is the one account, with identity, plan,
  // usage windows and its own Sign out.
  for (const name of ["Grok", "Kimi Code"]) {
    const section = within(panel).getByRole("region", { name });
    const row = within(section).getByRole("article");
    expect(within(row).getByText("Default")).toBeInTheDocument();
    expect(within(row).getByText("Subscription")).toBeInTheDocument();
    expect(within(row).getByText("Weekly")).toBeInTheDocument();
    expect(within(row).getByText("23% used")).toBeInTheDocument();
    expect(within(row).getByText("Plan: Reported plan")).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
    expect(within(section).getByRole("switch")).toBeDisabled();
    expect(
      within(section).getByRole("button", { name: "Add account" }),
    ).toBeDisabled();
    expect(within(section).queryByText(/Reset tokens/)).toBeNull();
  }
  const kimi = within(
    within(panel).getByRole("region", { name: "Kimi Code" }),
  ).getByRole("article");
  expect(within(kimi).getByText("Monthly coding")).toBeInTheDocument();
  expect(within(kimi).getByText("87% used")).toBeInTheDocument();
  expect(
    screen.getByText("Extra usage: $7.50 of $20.00 left"),
  ).toBeInTheDocument();
  // Stored providers without accounts say so and offer Add account.
  for (const name of ["Codex", "Claude Code", "Z.ai"]) {
    const section = within(panel).getByRole("region", { name });
    expect(
      within(section).getByText("No saved accounts for this provider."),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole("button", { name: "Add account" }),
    ).toBeEnabled();
    expect(within(section).getByRole("switch")).toBeEnabled();
  }
  // A CLI sign-in no status adapter reports on takes the harness probe's
  // word and never claims usage it cannot see.
  const amp = within(within(panel).getByRole("region", { name: "Amp" }));
  expect(amp.getByText("Usage limits not reported")).toBeInTheDocument();
  expect(amp.getByText("Plan: Not reported")).toBeInTheDocument();
  expect(amp.queryByRole("button", { name: "Sign out" })).toBeNull();
  expect(amp.queryByRole("button", { name: "Sign in" })).toBeNull();
  const copilot = within(
    within(panel).getByRole("region", { name: "Copilot" }),
  );
  expect(copilot.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  expect(copilot.queryByText("Usage limits not reported")).toBeNull();
  expect(screen.queryByText("Other providers")).toBeNull();
  expect(screen.getAllByText(/^Last checked/)).toHaveLength(1);
  expect(screen.getByText(/^Last checked/)).toHaveAttribute(
    "datetime",
    new Date(checkedAt).toISOString(),
  );
});

it("shows each provider once with setup inside its card and one refresh", () => {
  renderPage();
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
