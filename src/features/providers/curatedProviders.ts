import type { AcpProvider } from "@/shared/api/acp";
import type { ProviderCatalogEntry } from "@/shared/types/providers";

/** Harness a new chat runs on when nothing else chose one. */
export const DEFAULT_HARNESS_ID = "claude-acp";

export const CURATED_PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: "claude-acp",
    displayName: "Claude Code",
    category: "agent",
    description: "Anthropic's agentic coding tool",
    setupMethod: "cli_auth",
    binaryName: "claude-agent-acp",
    group: "default",
    aliases: ["claude-acp", "claude_code", "claude-code", "claude"],
    supportsInstall: true,
    supportsAuth: true,
    supportsAuthStatus: true,
    supportsLogout: true,
    bundledBridge: true,
  },
  {
    id: "codex-acp",
    displayName: "Codex",
    category: "agent",
    description: "OpenAI's coding agent",
    setupMethod: "cli_auth",
    binaryName: "codex-acp",
    group: "default",
    aliases: ["codex-acp", "codex_cli", "codex-cli", "codex"],
    supportsInstall: true,
    supportsAuth: true,
    supportsAuthStatus: true,
    supportsLogout: true,
    bundledBridge: true,
  },
  {
    id: "grok-acp",
    displayName: "Grok",
    category: "agent",
    description: "xAI Grok command-line agent",
    setupMethod: "cli_auth",
    binaryName: "grok",
    group: "default",
    aliases: ["grok-acp", "grok_cli", "grok-cli", "grok"],
    supportsInstall: true,
    supportsAuth: true,
    supportsAuthStatus: true,
    supportsLogout: true,
  },
  {
    id: "copilot-acp",
    displayName: "Copilot",
    category: "agent",
    description: "GitHub Copilot coding agent",
    setupMethod: "cli_auth",
    binaryName: "copilot",
    group: "default",
    aliases: ["copilot-acp", "copilot"],
    supportsInstall: true,
    supportsAuth: true,
    supportsAuthStatus: false,
  },
  {
    id: "amp-acp",
    displayName: "Amp",
    category: "agent",
    description: "Sourcegraph Amp coding agent",
    setupMethod: "cli_auth",
    binaryName: "amp-acp",
    group: "default",
    aliases: ["amp-acp", "amp"],
    supportsInstall: true,
    supportsAuth: true,
    supportsAuthStatus: true,
    supportsModelList: false,
    modelSelectionHint: "Use the Amp CLI to configure the model.",
  },
];

export const CURATED_PROVIDER_CATALOG_BY_ID = new Map(
  CURATED_PROVIDER_CATALOG.map((provider) => [provider.id, provider]),
);

export function getCuratedAgentProviders(): AcpProvider[] {
  return CURATED_PROVIDER_CATALOG.map((provider) => ({
    id: provider.id,
    label: provider.displayName,
  }));
}
