import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import {
  getAgentProviders,
  getCatalogEntry,
  resolveAgentProviderCatalogId,
} from "./providerCatalog";
import { useProviderCatalogStore } from "./stores/providerCatalogStore";

const catalogEntries: ProviderCatalogEntry[] = [
  {
    id: "claude-acp",
    displayName: "Claude Code",
    category: "agent",
    description: "Anthropic's agentic coding tool",
    setupMethod: "cli_auth",
    binaryName: "claude-agent-acp",
    group: "default",
    aliases: ["claude-acp", "claude_code", "claude"],
    supportsInstall: true,
    supportsAuth: true,
    supportsAuthStatus: true,
  },
  {
    id: "codex-acp",
    displayName: "Codex",
    category: "agent",
    description: "OpenAI's coding agent",
    setupMethod: "cli_auth",
    binaryName: "codex-acp",
    group: "default",
    aliases: ["codex-acp", "codex_cli", "codex"],
  },
];

describe("provider catalog selectors", () => {
  beforeEach(() => {
    useProviderCatalogStore.getState().reset();
  });

  it("returns the curated harnesses by default", () => {
    expect(getAgentProviders().map((provider) => provider.id)).toEqual([
      "claude-acp",
      "codex-acp",
      "grok-acp",
      "copilot-acp",
      "amp-acp",
    ]);
  });

  it("does not alias the Grok agent to the xAI model provider id", () => {
    expect(getCatalogEntry("grok-acp")?.aliases).toEqual([
      "grok-acp",
      "grok_cli",
      "grok-cli",
      "grok",
    ]);
    expect(resolveAgentProviderCatalogId("xai")).toBeNull();
  });

  it("uses loaded cache entries for provider selectors", () => {
    useProviderCatalogStore.getState().setEntries(catalogEntries);

    expect(getAgentProviders().map((provider) => provider.id)).toEqual([
      "claude-acp",
      "codex-acp",
    ]);
  });

  it("matches direct agent ids", () => {
    useProviderCatalogStore.getState().setEntries(catalogEntries);

    expect(resolveAgentProviderCatalogId("claude-acp", "Claude Code")).toBe(
      "claude-acp",
    );
  });

  it("matches backend-provided agent aliases", () => {
    useProviderCatalogStore.getState().setEntries(catalogEntries);

    expect(resolveAgentProviderCatalogId("codex-cli", "Codex CLI")).toBe(
      "codex-acp",
    );
    expect(
      resolveAgentProviderCatalogId("custom-id", "Claude Code (ACP)"),
    ).toBe("claude-acp");
  });

  it("matches suffixed agent labels from backend aliases", () => {
    useProviderCatalogStore.getState().setEntries(catalogEntries);

    expect(resolveAgentProviderCatalogId("custom-id", "Codex CLI (ACP)")).toBe(
      "codex-acp",
    );
  });

  it("does not match aliases embedded in unrelated labels", () => {
    useProviderCatalogStore.getState().setEntries(catalogEntries);

    expect(
      resolveAgentProviderCatalogId("custom-id", "Acme Claude Tools"),
    ).toBeNull();
    expect(
      resolveAgentProviderCatalogId("custom-id", "Codex compatible API"),
    ).toBeNull();
  });
});
