import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentProviderReadiness } from "@/features/providers/hooks/useAgentProviderStatus";
import { CURATED_PROVIDER_CATALOG } from "@/features/providers/curatedProviders";
import { recordReadyProviders } from "@/features/providers/lib/providerConnections";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useAgentSetupStore } from "@/features/providers/stores/agentSetupStore";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import { useProviderRateLimitsStore } from "../stores/providerRateLimitsStore";
import { ProviderSegment } from "./ProviderSegment";
import { StatusBar } from "./StatusBar";

const readiness = vi.hoisted(() => new Map<string, AgentProviderReadiness>());
vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({ agentReadiness: readiness }),
}));
vi.mock("@/features/settings/lib/settingsEvents", () => ({
  requestOpenSettings: vi.fn(),
}));
vi.mock("../stores/providerRateLimitsStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../stores/providerRateLimitsStore")
  >()),
  startProviderRateLimitPolling: () => () => {},
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  readiness.clear();
  for (const provider of CURATED_PROVIDER_CATALOG) {
    readiness.set(provider.id, "not_installed");
  }
  useProviderCatalogStore.setState({ entries: CURATED_PROVIDER_CATALOG });
  useProviderRateLimitsStore.setState({
    snapshot: null,
    emptyCtaDismissed: false,
    isRefreshing: false,
  });
});

it("does not offer sign-in for a CLI installed by an abandoned setup", () => {
  // Setup installed Copilot and was closed before its sign-in; nothing was
  // ever connected, so there is no account to show or restore.
  readiness.set("copilot-acp", "not_ready");
  render(<StatusBar />);
  expect(
    screen.getByRole("button", { name: "Configure usage tracking" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Usage" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Sign in")).not.toBeInTheDocument();
});

it("offers sign-in for a provider that signed in before and signed out", () => {
  recordReadyProviders(new Set(["grok-acp"]), 1);
  recordReadyProviders(new Set(), 2);
  readiness.set("grok-acp", "not_ready");
  render(<StatusBar />);
  expect(screen.getByRole("button", { name: "Usage" })).toBeInTheDocument();
  expect(screen.getByText("Sign in")).toBeInTheDocument();
});

it("opens provider settings from the empty bar without starting any setup", async () => {
  const start = vi.spyOn(useAgentSetupStore.getState(), "startSetup");
  render(<StatusBar />);
  await userEvent.click(
    screen.getByRole("button", { name: "Configure usage tracking" }),
  );
  expect(requestOpenSettings).toHaveBeenCalledWith("providers");
  expect(start).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: /connect all/i }),
  ).not.toBeInTheDocument();
});

it("shows a refused account as refused, not by its untouched usage windows", () => {
  // Z.ai reports its plan untouched while it refuses every request.
  const notice =
    "The provider refuses every request on this account: “Insufficient balance or no resource package. Please recharge.”";
  render(
    <ProviderSegment
      provider={{
        provider: "zai-acp",
        accountId: "invented-account",
        refused:
          "Insufficient balance or no resource package. Please recharge.",
        error: notice,
        session: {
          usedPercent: 0,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null,
        },
        weekly: null,
        planType: "GLM Coding Plan Lite",
        updatedAt: 1,
        status: "error",
        configured: true,
      }}
    />,
  );
  expect(screen.getByText("Refuses requests")).toBeInTheDocument();
  expect(screen.getByTitle(notice)).toBeInTheDocument();
  expect(screen.queryByText(/0%/)).not.toBeInTheDocument();
});

it("keeps refresh for existing providers without offering bulk setup", async () => {
  readiness.set("claude-acp", "ready");
  // A ready harness is listed once it has been connected; the bar never
  // shows a sign-in that was never completed.
  recordReadyProviders(new Set(["claude-acp"]), 1);
  const refresh = vi
    .spyOn(useProviderRateLimitsStore.getState(), "refresh")
    .mockResolvedValue();
  const start = vi.spyOn(useAgentSetupStore.getState(), "startSetup");
  render(<StatusBar />);
  expect(screen.getByRole("button", { name: "Usage" })).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /connect all/i }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Refresh rate limits" }),
  );
  expect(refresh).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
});
