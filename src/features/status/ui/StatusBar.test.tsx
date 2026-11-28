import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentProviderReadiness } from "@/features/providers/hooks/useAgentProviderStatus";
import { CURATED_PROVIDER_CATALOG } from "@/features/providers/curatedProviders";
import { recordReadyProviders } from "@/features/providers/lib/providerConnections";
import { useProviderAccountsStore } from "@/features/providers/stores/providerAccountsStore";
import { providerModelState, providerModels } from "@/test/providerModels";
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
  useProviderAccountsStore.setState(
    providerModelState(providerModels(["antigravity-acp", "amp-acp"], [])),
  );
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

it("shows Antigravity's connection without inventing usage for its CLI account", async () => {
  const id = "antigravity-acp";
  readiness.set(id, "ready");
  readiness.set("amp-acp", "ready");
  recordReadyProviders(new Set([id, "amp-acp"]), 1);
  useProviderRateLimitsStore.setState({
    snapshot: {
      updatedAt: 1,
      providers: [
        {
          provider: id,
          accountId: `cli-login-${id}`,
          session: null,
          weekly: null,
          updatedAt: 0,
          error: null,
          status: "ok",
          configured: true,
        },
      ],
    },
  });
  const { rerender } = render(<StatusBar />);
  expect(screen.getByTitle("Google Antigravity")).toHaveTextContent(
    "Connected",
  );
  expect(screen.queryByText(/\d+%/)).toBeNull();
  expect(screen.queryByTitle("Amp")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Usage" }));
  expect(screen.getByText("Google Antigravity")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  readiness.set(id, "not_ready");
  // The real hook supplies a new map after a fresh doctor report.
  useProviderRateLimitsStore.setState({ snapshot: null });
  rerender(<StatusBar />);
  expect(screen.getByText("Sign in")).toBeVisible();
});

it("offers sign-in for a provider that signed in before and signed out", () => {
  recordReadyProviders(new Set(["grok-acp"]), 1);
  recordReadyProviders(new Set(), 2);
  readiness.set("grok-acp", "not_ready");
  render(<StatusBar />);
  expect(screen.getByRole("button", { name: "Usage" })).toBeInTheDocument();
  expect(screen.getByText("Sign in")).toBeInTheDocument();
});

it("shows the Gemini subscription windows only while Antigravity is installed and signed in", () => {
  const id = "antigravity-acp";
  const snapshot = {
    updatedAt: 1,
    providers: [
      {
        provider: id,
        accountId: `cli-login-${id}`,
        session: null,
        weekly: null,
        updatedAt: 1,
        error: null,
        status: "ok" as const,
        configured: true,
        modelWindows: (["session", "weekly"] as const).map((period) => ({
          modelId: "Gemini",
          period,
          window: {
            usedPercent: period === "session" ? 15 : 31,
            windowMinutes: period === "session" ? 300 : 10080,
            resetsAt: null,
            resetDescription: null,
          },
        })),
      },
    ],
  };
  readiness.set(id, "ready");
  useProviderRateLimitsStore.setState({ snapshot, usageMode: "verbose" });
  const { unmount } = render(<StatusBar />);
  expect(screen.getByText(/Gemini.*15%/)).toBeVisible();
  expect(screen.getByText(/Gemini.*31%/)).toBeVisible();
  unmount();
  readiness.set(id, "not_installed");
  render(<StatusBar />);
  expect(screen.queryByText(/Gemini.*%/)).toBeNull();
  expect(
    screen.getByRole("button", { name: "Configure usage tracking" }),
  ).toBeVisible();
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
  // Z.ai reports its plan untouched while it refuses a key with no balance.
  const notice =
    "Z.ai refused this account's request: “Insufficient balance or no resource package. Please recharge.”";
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
        planType: "Lite",
        updatedAt: 1,
        status: "error",
        configured: true,
      }}
    />,
  );
  expect(screen.getByText("Requests refused")).toBeInTheDocument();
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
