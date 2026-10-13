import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentProviderReadiness } from "@/features/providers/hooks/useAgentProviderStatus";
import { CURATED_PROVIDER_CATALOG } from "@/features/providers/curatedProviders";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useAgentSetupStore } from "@/features/providers/stores/agentSetupStore";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import { useProviderRateLimitsStore } from "../stores/providerRateLimitsStore";
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

it("keeps refresh for existing providers without offering bulk setup", async () => {
  readiness.set("claude-acp", "ready");
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
