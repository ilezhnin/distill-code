import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import enStatus from "@/shared/i18n/locales/en/status.json";
import type { ProviderRateLimitSnapshot } from "../../lib/rateLimitTypes";
import { useProviderRateLimitsStore } from "../../stores/providerRateLimitsStore";
import { StatusBar } from "../StatusBar";

const mocks = vi.hoisted(() => ({
  connectAll: vi.fn(),
  connectOne: vi.fn(),
  openAccounts: vi.fn(),
  openUsage: vi.fn(),
  getProviderRateLimits: vi.fn(),
  readiness: new Map<string, "ready" | "not_ready" | "not_installed">([
    ["claude-acp", "not_ready"],
    ["grok-acp", "not_installed"],
    ["codex-acp", "not_ready"],
  ]),
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: new Set(),
    agentReadiness: mocks.readiness,
    agentChecks: new Map(),
    loading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/features/status/lib/connectPlatforms", () => ({
  openProviderAccounts: () => mocks.openAccounts(),
  openUsageDetails: () => mocks.openUsage(),
  connectAgentPlatform: (...args: unknown[]) => mocks.connectOne(...args),
  connectAllAgentPlatforms: (...args: unknown[]) => mocks.connectAll(...args),
  canConnectPlatform: () => true,
}));

vi.mock("@/features/status/api/providerRateLimits", () => ({
  getProviderRateLimits: () => mocks.getProviderRateLimits(),
}));

const snapshot: ProviderRateLimitSnapshot = {
  updatedAt: Date.now(),
  providers: [
    {
      provider: "claude-acp",
      session: {
        usedPercent: 3,
        windowMinutes: 300,
        resetsAt: Date.now() + 60_000,
        resetDescription: null,
      },
      weekly: {
        usedPercent: 99,
        windowMinutes: 10080,
        resetsAt: Date.now() + 14 * 60 * 60 * 1000,
        resetDescription: null,
      },
      fableWeekly: {
        usedPercent: 100,
        windowMinutes: 10080,
        resetsAt: Date.now() + 14 * 60 * 60 * 1000,
        resetDescription: null,
      },
      updatedAt: Date.now(),
      error: null,
      status: "ok",
      configured: true,
    },
    {
      provider: "grok-acp",
      session: null,
      weekly: {
        usedPercent: 8,
        windowMinutes: 10080,
        resetsAt: Date.now() + 5 * 24 * 60 * 60 * 1000,
        resetDescription: null,
      },
      updatedAt: Date.now(),
      error: null,
      status: "ok",
      configured: true,
      accountLabel: "dev@example.com",
    },
    {
      provider: "codex-acp",
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: "RPC process exited unexpectedly",
      status: "error",
      configured: true,
    },
  ],
};

describe("StatusBar", () => {
  beforeEach(() => {
    mocks.connectAll.mockReset();
    mocks.connectOne.mockReset();
    mocks.openAccounts.mockReset();
    mocks.openUsage.mockReset();
    mocks.getProviderRateLimits.mockReset().mockResolvedValue(snapshot);
    useProviderRateLimitsStore.setState({
      snapshot,
      isRefreshing: false,
      error: null,
      usageMode: "verbose",
      emptyCtaDismissed: false,
    });
  });

  it("renders connected platform chips and opens the usage roster", async () => {
    const user = userEvent.setup();
    await act(async () => {
      renderWithProviders(<StatusBar />);
    });

    expect(screen.getByTestId("app-status-bar")).toBeInTheDocument();
    expect(screen.getByText(/3% used/i)).toBeInTheDocument();
    expect(screen.getByText(/100% used Fable/i)).toBeInTheDocument();
    expect(screen.getByText(enStatus.bar.refreshFailed)).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: enStatus.roster.title }),
    );
    expect(screen.getByText(enStatus.roster.detailed)).toBeInTheDocument();
    expect(screen.getByText(enStatus.roster.usageDetails)).toBeInTheDocument();
    expect(
      screen.getByText(enStatus.roster.manageAccounts),
    ).toBeInTheDocument();
  });

  it("opens the connect-all menu and starts platform setup", async () => {
    const user = userEvent.setup();
    await act(async () => {
      renderWithProviders(<StatusBar />);
    });

    await user.click(
      screen.getByRole("button", { name: enStatus.bar.connectAll }),
    );
    expect(
      screen.getByRole("menuitem", {
        name: new RegExp(enStatus.providers["claude-acp"]),
      }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("menuitem", { name: enStatus.bar.connectAll }),
    );
    expect(mocks.connectAll).toHaveBeenCalled();
  });
});
