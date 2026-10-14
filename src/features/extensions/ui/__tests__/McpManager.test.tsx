import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  listExtensions: vi.fn(),
  saveExtension: vi.fn(),
  removeExtension: vi.fn(),
  setExtensionEnabled: vi.fn(),
  listLocalMcpInventory: vi.fn(),
  listMcpDiagnostics: vi.fn(),
  readLocalMcpConfiguration: vi.fn(),
  updateLocalMcpConfiguration: vi.fn(),
  checkMcpConnection: vi.fn(),
}));
vi.mock("../../api/extensions", () => ({
  listExtensions: mocks.listExtensions,
  saveExtension: mocks.saveExtension,
  removeExtension: mocks.removeExtension,
  setExtensionEnabled: mocks.setExtensionEnabled,
}));
vi.mock("../../api/localMcpInventory", () => ({
  listLocalMcpInventory: mocks.listLocalMcpInventory,
  LOCAL_MCP_INVENTORY_QUERY_KEY: ["mcp-inventory"],
}));
vi.mock("../../api/mcpManager", () => ({
  ...mocks,
  MANAGED_MCP_QUERY_KEY: ["managed-mcps"],
  MCP_DIAGNOSTICS_QUERY_KEY: ["mcp-diagnostics"],
}));

import { McpManager } from "../McpManager";

const source = {
  id: "codex-fixture",
  harness: "codex",
  source: { scope: "user", label: "Codex user config" },
  configKey: "example",
  name: "example",
  transport: "http",
  identityFingerprint: "one",
  enabled: true,
  endpoint: "https://example.com/mcp",
  configurationRevision: "current",
};
const managed = {
  name: "demo",
  type: "streamable_http",
  description: "Demo service",
  uri: "https://example.com/mcp",
  config_key: "demo",
  enabled: true,
  configurationRevision: "current",
};

function renderManager(workspacePaths: string[] = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderWithProviders(
    <QueryClientProvider client={client}>
      <McpManager workspacePaths={workspacePaths} />
    </QueryClientProvider>,
  );
}

describe("MCP management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listLocalMcpInventory.mockResolvedValue({
      harnesses: [
        {
          harness: "codex",
          status: "configured",
          checkedLocations: [],
          servers: [source],
        },
      ],
    });
    mocks.listExtensions.mockResolvedValue([managed]);
    mocks.listMcpDiagnostics.mockResolvedValue({});
    mocks.readLocalMcpConfiguration.mockResolvedValue({
      configuration: {
        url: "https://example.com/mcp",
        bearer_token_env_var: "EXAMPLE_TOKEN",
      },
      revision: "file-revision",
      source: "Codex user config",
    });
    mocks.saveExtension.mockResolvedValue(undefined);
    mocks.removeExtension.mockResolvedValue(undefined);
    mocks.setExtensionEnabled.mockResolvedValue(undefined);
    mocks.updateLocalMcpConfiguration.mockResolvedValue(undefined);
  });

  it("exposes only a provider-specific switch for inherited Grok settings", async () => {
    const user = userEvent.setup();
    mocks.listExtensions.mockResolvedValue([]);
    mocks.listLocalMcpInventory.mockResolvedValue({
      harnesses: [
        {
          harness: "grok",
          status: "configured",
          checkedLocations: [],
          servers: [
            {
              ...source,
              id: "grok-inherited:fixture",
              harness: "grok",
              source: {
                scope: "user",
                label: "Grok inherits Claude Code user config",
              },
            },
          ],
        },
      ],
    });
    renderManager();
    await user.click(await screen.findByRole("button", { name: "Details" }));
    expect(
      screen.queryByRole("button", { name: "Configure example" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove example" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Enable example for Grok" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/This switch controls Grok only/),
    ).toBeInTheDocument();
  });

  it("lists installed servers without starting or reading their secret configuration", async () => {
    renderManager();
    expect(await screen.findByText("demo")).toBeInTheDocument();
    expect(await screen.findByText("example")).toBeInTheDocument();
    expect(mocks.checkMcpConnection).not.toHaveBeenCalled();
    expect(mocks.readLocalMcpConfiguration).not.toHaveBeenCalled();
  });

  it("adds a remote server from its configuration without connecting it", async () => {
    const user = userEvent.setup();
    renderManager();
    await user.click(await screen.findByRole("button", { name: "Add MCP" }));
    await user.type(screen.getByLabelText("Name"), "new-service");
    await user.type(
      screen.getByLabelText("Server URL"),
      "https://example.com/new-mcp",
    );
    await user.click(screen.getByRole("button", { name: "Add server" }));
    await waitFor(() =>
      expect(mocks.saveExtension).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "new-service",
          type: "streamable_http",
          uri: "https://example.com/new-mcp",
        }),
      ),
    );
    expect(mocks.checkMcpConnection).not.toHaveBeenCalled();
  });

  it("uses the provider's configuration revision and preserves unedited settings", async () => {
    const user = userEvent.setup();
    renderManager(["/workspace"]);
    const example = await screen.findByText("example");
    await user.click(
      within(example.closest('[data-slot="card"]') as HTMLElement).getByRole(
        "button",
        { name: "Details" },
      ),
    );
    await user.click(screen.getByRole("button", { name: "Configure example" }));
    const url = await screen.findByLabelText("Server URL");
    await user.clear(url);
    await user.type(url, "https://example.com/updated");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.updateLocalMcpConfiguration).toHaveBeenCalledWith(
        "codex-fixture",
        "file-revision",
        ["/workspace"],
        {
          configuration: expect.objectContaining({
            url: "https://example.com/updated",
            bearer_token_env_var: "EXAMPLE_TOKEN",
          }),
        },
      ),
    );
  });

  it("requires confirmation before removing an installed connection", async () => {
    const user = userEvent.setup();
    renderManager();
    const demo = await screen.findByText("demo");
    await user.click(
      within(demo.closest('[data-slot="card"]') as HTMLElement).getByRole(
        "button",
        { name: "Details" },
      ),
    );
    await user.click(screen.getByRole("button", { name: "Remove demo" }));
    expect(mocks.removeExtension).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.removeExtension).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Remove demo" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(mocks.removeExtension).toHaveBeenCalledWith("demo"),
    );
  });

  it("checks on request and displays authentication failures with their details", async () => {
    const user = userEvent.setup();
    const diagnostic = {
      status: "needsAuth",
      checkedAt: "2026-10-14T12:00:00Z",
      configurationRevision: "current",
      message: "Server requires authentication",
      serverName: null,
      serverVersion: null,
      tools: [],
    };
    mocks.checkMcpConnection.mockImplementation(async () => {
      mocks.listMcpDiagnostics.mockResolvedValue({
        "distill:demo": diagnostic,
      });
      return diagnostic;
    });
    renderManager();
    const demo = await screen.findByText("demo");
    await user.click(
      within(demo.closest('[data-slot="card"]') as HTMLElement).getByRole(
        "button",
        { name: "Details" },
      ),
    );
    expect(mocks.checkMcpConnection).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Check connection" }));
    expect(
      await screen.findByText("Server requires authentication"),
    ).toBeInTheDocument();
    expect(mocks.checkMcpConnection).toHaveBeenCalledWith(
      "distill:demo",
      [],
      expect.objectContaining({ uri: "https://example.com/mcp" }),
    );
    expect(mocks.checkMcpConnection.mock.calls[0][2]).not.toHaveProperty(
      "config_key",
    );
  });
});
