import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useProviderAccountsStore } from "@/features/providers/stores/providerAccountsStore";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
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
    entries: ["codex-acp", "claude-acp", "grok-acp"].flatMap((id) => {
      const entry = CURATED_PROVIDER_CATALOG_BY_ID.get(id);
      return entry ? [entry] : [];
    }),
  });
  useProviderAccountsStore.setState({
    accounts: [],
    defaults: {},
    automaticSwitching: {},
    loaded: true,
    refreshing: false,
    error: null,
    refresh: mocks.refresh,
  });
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
