import { describe, expect, it } from "vitest";
import { resolveSelectedAgentId } from "../agentProviderResolution";
import { DEFAULT_HARNESS_ID } from "@/features/providers/curatedProviders";
import type { ProviderCatalogEntry } from "@/shared/types/providers";

const catalogEntries: ProviderCatalogEntry[] = [
  {
    id: "claude-acp",
    displayName: "Claude Code",
    category: "agent",
    description: "Claude Code",
    setupMethod: "cli_auth",
    group: "default",
    aliases: ["claude-acp", "claude_code", "claude"],
  },
  {
    id: "codex-acp",
    displayName: "Codex",
    category: "agent",
    description: "Codex",
    setupMethod: "cli_auth",
    group: "default",
    aliases: ["codex-acp", "codex"],
  },
];

describe("resolveSelectedAgentId", () => {
  it("returns the default harness when no provider is selected", () => {
    expect(
      resolveSelectedAgentId({
        catalogEntries,
        catalogLoaded: true,
        selectedProvider: undefined,
      }),
    ).toBe(DEFAULT_HARNESS_ID);
  });

  it("resolves known agents and their aliases from the catalog", () => {
    expect(
      resolveSelectedAgentId({
        catalogEntries,
        catalogLoaded: true,
        selectedProvider: "codex",
      }),
    ).toBe("codex-acp");
  });

  it("preserves any provider before the catalog loads", () => {
    expect(
      resolveSelectedAgentId({
        catalogEntries: [],
        catalogLoaded: false,
        selectedProvider: "some-future-agent",
      }),
    ).toBe("some-future-agent");
  });

  it("falls back to the default harness for an unknown provider", () => {
    expect(
      resolveSelectedAgentId({
        catalogEntries,
        catalogLoaded: true,
        selectedProvider: "nonexistent-provider",
      }),
    ).toBe(DEFAULT_HARNESS_ID);
  });
});
