import { describe, expect, it } from "vitest";
import {
  configurationFromDraft,
  latestItemDiagnostic,
  mcpItems,
} from "./mcpManager";
import type { ExtensionEntry } from "../types";

describe("MCP manager state", () => {
  it("invalidates recorded health after a configuration change", () => {
    const [item] = mcpItems(undefined, [
      {
        type: "stdio",
        name: "example",
        description: "",
        cmd: "node",
        args: [],
        config_key: "example",
        enabled: true,
        configurationRevision: "new",
      },
    ]);
    expect(
      latestItemDiagnostic(item, {
        [item.id]: {
          status: "connected",
          checkedAt: "2026-10-14",
          configurationRevision: "old",
          message: null,
          serverName: "example",
          serverVersion: "1",
          tools: [],
        },
      }),
    ).toBeUndefined();
  });

  it("never renders credential-bearing URLs in list details", () => {
    const [item] = mcpItems(undefined, [
      {
        type: "streamable_http",
        name: "example",
        description: "",
        uri: "https://user:password@example.com/mcp?token=secret",
        config_key: "example",
        enabled: true,
      } satisfies ExtensionEntry,
    ]);
    expect(item.endpoint).toBe("https://example.com/mcp");
  });

  it("keeps a provider failure visible after another provider connects", () => {
    const item = {
      id: "shared",
      name: "shared",
      description: "",
      transport: "http",
      sources: [
        { id: "first", configurationRevision: "first-revision", enabled: true },
        {
          id: "second",
          configurationRevision: "second-revision",
          enabled: true,
        },
      ],
    } as Parameters<typeof latestItemDiagnostic>[0];
    const common = {
      message: null,
      serverName: null,
      serverVersion: null,
      tools: [],
    };
    const diagnostics = {
      first: {
        ...common,
        status: "needsAuth" as const,
        checkedAt: "2026-10-14T10:00:00Z",
        configurationRevision: "first-revision",
      },
      second: {
        ...common,
        status: "connected" as const,
        checkedAt: "2026-10-14T11:00:00Z",
        configurationRevision: "second-revision",
      },
    };
    expect(latestItemDiagnostic(item, diagnostics)?.status).toBe("needsAuth");
    item.sources[0].enabled = false;
    expect(latestItemDiagnostic(item, diagnostics)?.status).toBe("connected");
  });

  it("retains provider-specific options when changing a connection", () => {
    const config = configurationFromDraft(
      {
        name: "example",
        description: "Updated",
        transport: "http",
        command: "",
        args: [],
        url: "https://example.com/mcp",
        env: {},
        headers: {},
      },
      {
        bearer_token_env_var: "EXAMPLE_TOKEN",
        startup_timeout_sec: 30,
        url: "https://example.com/old",
      },
      "codex",
    );
    expect(config).toMatchObject({
      bearer_token_env_var: "EXAMPLE_TOKEN",
      startup_timeout_sec: 30,
      url: "https://example.com/mcp",
    });
    expect(config).not.toHaveProperty("type");
  });
});
