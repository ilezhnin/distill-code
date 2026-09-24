import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/shared/i18n";
import { AgentProviderCard } from "../AgentProviderCard";
import type { AgentProviderReadiness } from "@/features/providers/hooks/useAgentProviderStatus";
import type { DoctorCheck } from "@/shared/api/doctor";
import type { AgentSetupOperation } from "@/features/providers/api/agentSetup";
import { useAgentSetupStore } from "@/features/providers/stores/agentSetupStore";
import type { ProviderDisplayInfo } from "@/shared/types/providers";
import { CURATED_PROVIDER_CATALOG_BY_ID } from "@/features/providers/curatedProviders";
import { AGENT_SETUP_FAILURE_SIMULATION_KEY } from "@/features/providers/lib/agentSetupFailureSimulation";

// Setup progress is now backend-owned: the card kicks an operation off through
// the store (`startAgentSetup`) and renders the snapshot the store mirrors from
// `agent-setup:state`. The multi-step install loop / update ordering / verify
// chain itself lives in Rust (`agent_setup.rs` unit tests cover its
// transitions), so these tests assert the *plan* the card builds and the view
// it renders from the store, not the in-card orchestration that used to exist.
const startAgentSetup = vi.fn();
const listAgentSetupStatus = vi.fn();
const clearAgentSetupStatus = vi.fn();
const onAgentSetupState = vi.fn();

vi.mock("@/features/providers/api/agentSetup", () => ({
  startAgentSetup: (...args: unknown[]) => startAgentSetup(...args),
  listAgentSetupStatus: (...args: unknown[]) => listAgentSetupStatus(...args),
  clearAgentSetupStatus: (...args: unknown[]) => clearAgentSetupStatus(...args),
  onAgentSetupState: (...args: unknown[]) => onAgentSetupState(...args),
}));

const rerunDoctorReport = vi.fn();
const invalidateDoctorReport = vi.fn();

vi.mock("@/shared/api/useDoctorReport", () => ({
  rerunDoctorReport: (...args: unknown[]) => rerunDoctorReport(...args),
  invalidateDoctorReport: (...args: unknown[]) =>
    invalidateDoctorReport(...args),
}));

function makeOperation(
  overrides: Partial<AgentSetupOperation> = {},
): AgentSetupOperation {
  return {
    action: "install",
    phase: "installing",
    status: "running",
    output: [],
    error: null,
    ...overrides,
  };
}

// Drive the store the way the backend's `agent-setup:state` event would.
function emitOperation(providerId: string, operation: AgentSetupOperation) {
  act(() => {
    useAgentSetupStore.getState().setOperation(providerId, operation);
  });
}

// `startSetup` optimistically mirrors the backend's seeded running snapshot.
// Wait for that to land before emitting a terminal state, so the later
// `agent-setup:state` event isn't clobbered by the in-flight optimistic write.
async function waitForRunning(providerId: string) {
  await waitFor(() =>
    expect(useAgentSetupStore.getState().getStatus(providerId)?.status).toBe(
      "running",
    ),
  );
}

function renderCard(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (node: ReactElement) => (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>
  );
  const result = render(wrap(ui));
  return {
    ...result,
    rerender: (node: ReactElement) => result.rerender(wrap(node)),
  };
}

function createProvider(
  overrides: Partial<ProviderDisplayInfo> = {},
): ProviderDisplayInfo {
  return {
    id: "claude-acp",
    displayName: "Claude",
    category: "agent",
    description: "Claude provider",
    setupMethod: "cli_auth",
    binaryName: "claude",
    supportsAuth: true,
    supportsAuthStatus: true,
    group: "default",
    status: "connected",
    ...overrides,
  };
}

// Grok as the catalog declares it, so the sign-in flags under test are the
// shipped ones.
function grokProvider(): ProviderDisplayInfo {
  const entry = CURATED_PROVIDER_CATALOG_BY_ID.get("grok-acp");
  if (!entry) throw new Error("grok-acp is missing from the catalog");
  return { ...entry, status: "connected" };
}

function createVersionCheck(overrides: Partial<DoctorCheck> = {}): DoctorCheck {
  return {
    id: "ai-agent-claude",
    label: "Claude",
    status: "pass",
    message: "Installed",
    fixUrl: null,
    fixCommand: null,
    fixType: null,
    path: null,
    bridgePath: null,
    rawOutput: null,
    authStatus: null,
    installedVersion: null,
    latestVersion: null,
    updateAvailable: null,
    installSource: null,
    selfUpdating: null,
    main: null,
    bridge: null,
    category: "agents",
    categoryLabel: "Agents",
    ...overrides,
  };
}

describe("AgentProviderCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem(AGENT_SETUP_FAILURE_SIMULATION_KEY);
    // The backend seeds a running snapshot and returns it; the store mirrors it.
    startAgentSetup.mockResolvedValue(makeOperation());
    clearAgentSetupStatus.mockResolvedValue(undefined);
    listAgentSetupStatus.mockResolvedValue([]);
    onAgentSetupState.mockResolvedValue(vi.fn());
    rerunDoctorReport.mockResolvedValue(undefined);
    invalidateDoctorReport.mockResolvedValue(undefined);
    // Each test starts with an empty backend-state mirror.
    useAgentSetupStore.setState({ operations: new Map() });
  });

  it("signs in an installed-but-unauthenticated agent", async () => {
    const user = userEvent.setup();

    renderCard(
      <AgentProviderCard
        provider={createProvider({
          status: "not_installed",
          supportsInstall: true,
          supportsAuth: true,
          supportsAuthStatus: true,
        })}
        statusLoading={false}
        readiness={"not_ready" satisfies AgentProviderReadiness}
      />,
    );

    expect(
      screen.getByRole("button", { name: /sign in/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /install claude/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(startAgentSetup).toHaveBeenCalledWith("claude-acp", "auth", {
        installFixType: null,
        updateFixTypes: [],
        verifyInstall: true,
      });
    });
  });

  it("signs out a signed-in agent so a different account can sign in", async () => {
    const user = userEvent.setup();

    renderCard(
      <AgentProviderCard
        provider={grokProvider()}
        statusLoading={false}
        readiness={"ready" satisfies AgentProviderReadiness}
      />,
    );

    await user.click(screen.getByRole("button", { name: /sign out of grok/i }));

    await waitFor(() => {
      expect(startAgentSetup).toHaveBeenCalledWith("grok-acp", "logout", {
        installFixType: null,
        updateFixTypes: [],
        verifyInstall: true,
      });
    });
  });

  it("starts an install (CLI recipe, no updates) without sign in when not installed", async () => {
    const user = userEvent.setup();

    renderCard(
      <AgentProviderCard
        provider={createProvider({
          status: "not_installed",
          supportsInstall: true,
          supportsAuth: true,
          supportsAuthStatus: true,
        })}
        statusLoading={false}
        readiness={"not_installed" satisfies AgentProviderReadiness}
      />,
    );

    expect(
      screen.getByRole("button", { name: /install claude/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /sign in to claude/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /install claude/i }));

    await waitFor(() => {
      expect(startAgentSetup).toHaveBeenCalledWith("claude-acp", "install", {
        installFixType: "command",
        updateFixTypes: [],
        verifyInstall: true,
      });
    });
  });

  it("retries a failed setup without clearing the backend entry first", async () => {
    const user = userEvent.setup();

    renderCard(
      <AgentProviderCard
        provider={createProvider({
          status: "not_installed",
          supportsInstall: true,
          supportsAuth: false,
          supportsAuthStatus: false,
        })}
        statusLoading={false}
        readiness={"not_installed" satisfies AgentProviderReadiness}
      />,
    );

    emitOperation(
      "claude-acp",
      makeOperation({
        action: "install",
        phase: "idle",
        status: "failed",
        error: "Command exited with code 1",
      }),
    );

    expect(await screen.findByText("Setup hit a snag.")).toBeInTheDocument();
    clearAgentSetupStatus.mockClear();
    startAgentSetup.mockClear();

    await user.click(screen.getByRole("button", { name: /^retry$/i }));

    await waitFor(() => {
      expect(startAgentSetup).toHaveBeenCalledWith("claude-acp", "install", {
        installFixType: "command",
        updateFixTypes: [],
        verifyInstall: true,
      });
    });
    expect(clearAgentSetupStatus).not.toHaveBeenCalled();
  });

  it("Fix builds a plan that installs the missing bridge and applies pending updates", async () => {
    const user = userEvent.setup();

    renderCard(
      <AgentProviderCard
        provider={createProvider({
          id: "codex-acp",
          displayName: "Codex",
          binaryName: "codex-acp",
          supportsInstall: true,
          supportsAuth: true,
          supportsAuthStatus: true,
        })}
        statusLoading={false}
        readiness={"not_installed" satisfies AgentProviderReadiness}
        versionCheck={createVersionCheck({
          id: "ai-agent-codex",
          label: "Codex",
          status: "warn",
          path: "/opt/homebrew/bin/codex",
          bridgePath: null,
          fixType: "bridge",
          installSource: "brew",
          installedVersion: "0.137.0",
          latestVersion: "0.139.0",
          updateAvailable: true,
          main: {
            installSource: "brew",
            installedVersion: "0.137.0",
            latestVersion: "0.139.0",
            updateAvailable: true,
            selfUpdating: null,
            updateCommand: "brew upgrade codex",
            updateFixType: "updateMain",
          },
          bridge: null,
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /fix codex/i }));

    // The plan seeds the *bridge* recipe (the check's fixType="bridge") so the
    // backend installs codex-acp rather than reinstalling the present CLI, and
    // carries the pending update so the stale CLI is brought current too. The
    // install-loop ordering itself is covered by the Rust unit tests.
    await waitFor(() => {
      expect(startAgentSetup).toHaveBeenCalledWith("codex-acp", "install", {
        installFixType: "bridge",
        updateFixTypes: ["updateMain"],
        verifyInstall: true,
      });
    });
  });

  it("carries every actionable readout in the update plan when main and bridge are stale", async () => {
    const user = userEvent.setup();

    renderCard(
      <AgentProviderCard
        provider={createProvider({
          supportsInstall: true,
          supportsAuth: false,
          supportsAuthStatus: false,
        })}
        statusLoading={false}
        readiness={"ready" satisfies AgentProviderReadiness}
        versionCheck={createVersionCheck({
          main: {
            installSource: "curlPipe",
            installedVersion: "2.0.0",
            latestVersion: "2.1.0",
            updateAvailable: true,
            selfUpdating: null,
            updateCommand: "curl -fsSL https://example.com/install.sh | bash",
            updateFixType: "updateMain",
          },
          bridge: {
            installSource: "npm",
            installedVersion: "0.34.0",
            latestVersion: "0.39.0",
            updateAvailable: true,
            selfUpdating: null,
            updateCommand: "npm install -g claude-agent-acp@latest",
            updateFixType: "updateBridge",
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /update claude/i }));

    await waitFor(() => {
      expect(startAgentSetup).toHaveBeenCalledWith("claude-acp", "update", {
        installFixType: null,
        updateFixTypes: ["updateMain", "updateBridge"],
        verifyInstall: true,
      });
    });
  });

  it("does not restart an automatic install across a pending remount", async () => {
    let resolveStart: ((operation: AgentSetupOperation) => void) | undefined;
    startAgentSetup.mockImplementationOnce(
      () =>
        new Promise<AgentSetupOperation>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const provider = createProvider({ supportsInstall: true });
    const first = renderCard(
      <AgentProviderCard
        provider={provider}
        statusLoading={false}
        readiness="not_installed"
        autoStartInstall
        autoInstallProgressOnly
      />,
    );
    await waitFor(() => expect(startAgentSetup).toHaveBeenCalledOnce());
    first.unmount();

    renderCard(
      <AgentProviderCard
        provider={provider}
        statusLoading={false}
        readiness="not_installed"
        autoStartInstall
        autoInstallProgressOnly
      />,
    );
    expect(startAgentSetup).toHaveBeenCalledOnce();

    resolveStart?.(makeOperation());
    await waitForRunning(provider.id);
  });

  it("surfaces an automatic install launch failure", async () => {
    startAgentSetup.mockRejectedValueOnce(new Error("backend unavailable"));
    renderCard(
      <AgentProviderCard
        provider={createProvider({ supportsInstall: true })}
        statusLoading={false}
        readiness="not_installed"
        autoStartInstall
        autoInstallProgressOnly
      />,
    );

    expect(await screen.findByText("Setup hit a snag.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
