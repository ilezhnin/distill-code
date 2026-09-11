import { beforeEach, describe, expect, it, vi } from "vitest";
import { addExtension, listExtensions, toggleExtension } from "./extensions";

const mockConfigExtensionsList = vi.fn();
const mockConfigExtensionsAdd = vi.fn();
const mockConfigExtensionsSetEnabled = vi.fn();

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({
    host: {
      configExtensionsList: mockConfigExtensionsList,
      configExtensionsAdd: mockConfigExtensionsAdd,
      configExtensionsSetEnabled: mockConfigExtensionsSetEnabled,
    },
  }),
}));

describe("extensions api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flattens stored extensions with their config key and enabled flag", async () => {
    mockConfigExtensionsList.mockResolvedValue({
      extensions: [
        {
          configKey: "github",
          enabled: true,
          extension: {
            type: "stdio",
            name: "github",
            description: "GitHub MCP",
            cmd: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            envs: { DEBUG: "1" },
            env_keys: ["GITHUB_TOKEN"],
          },
        },
        {
          configKey: null,
          enabled: false,
          extension: {
            type: "streamable_http",
            name: "remote",
            description: "Remote MCP",
            uri: "https://example.test/mcp",
            headers: { Authorization: "Bearer token" },
          },
        },
      ],
    });

    await expect(listExtensions()).resolves.toEqual([
      {
        type: "stdio",
        name: "github",
        description: "GitHub MCP",
        cmd: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        envs: { DEBUG: "1" },
        env_keys: ["GITHUB_TOKEN"],
        config_key: "github",
        enabled: true,
      },
      {
        type: "streamable_http",
        name: "remote",
        description: "Remote MCP",
        uri: "https://example.test/mcp",
        headers: { Authorization: "Bearer token" },
        config_key: "remote",
        enabled: false,
      },
    ]);
  });

  it("adds extensions verbatim under the given name", async () => {
    await addExtension(
      "github",
      {
        type: "stdio",
        name: "draft",
        description: "GitHub MCP",
        cmd: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        envs: { DEBUG: "1" },
        env_keys: ["GITHUB_TOKEN"],
      },
      true,
    );

    expect(mockConfigExtensionsAdd).toHaveBeenCalledWith({
      enabled: true,
      extension: {
        type: "stdio",
        name: "github",
        description: "GitHub MCP",
        cmd: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        envs: { DEBUG: "1" },
        env_keys: ["GITHUB_TOKEN"],
      },
    });
  });

  it("sets extension enabled state", async () => {
    await toggleExtension("github", false);

    expect(mockConfigExtensionsSetEnabled).toHaveBeenCalledWith({
      configKey: "github",
      enabled: false,
    });
  });
});
