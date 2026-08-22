import type { AgentProviderReadiness } from "@/features/providers/hooks/useAgentProviderStatus";
import {
  getAgentProvidersFromEntries,
  getCatalogEntryFromEntries,
  resolveAgentProviderCatalogIdStrictFromEntries,
} from "@/features/providers/providerCatalog";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import type { AgentPickerOption } from "../types";

export interface AgentPickerListProvider {
  id: string;
  label: string;
}

export function listVisibleAgentPickerOptions(options: {
  catalogEntries: ProviderCatalogEntry[];
  catalogLoaded: boolean;
  agentReadiness: Map<string, AgentProviderReadiness>;
  extraProviders?: readonly AgentPickerListProvider[];
  selectedAgentId?: string;
  readyAgentIds?: ReadonlySet<string>;
}): AgentPickerOption[] {
  const visible = new Map<string, AgentPickerOption>();

  const add = (agentId: string, label: string, allowUnknown: boolean) => {
    const resolvedId =
      resolveAgentProviderCatalogIdStrictFromEntries(
        options.catalogEntries,
        agentId,
      ) ?? (allowUnknown || !options.catalogLoaded ? agentId : null);
    if (!resolvedId || visible.has(resolvedId)) {
      return;
    }

    const catalogEntry = getCatalogEntryFromEntries(
      options.catalogEntries,
      resolvedId,
    );
    const readiness = options.agentReadiness.get(resolvedId) ?? "not_installed";
    const isSelected = resolvedId === options.selectedAgentId;
    // Composer lists installed harnesses. Install-only rows stay in
    // Settings. Goose without a model provider is installed-but-unusable,
    // so keep it out unless it is already the selected agent.
    if (readiness === "not_installed" && !isSelected) {
      return;
    }
    if (resolvedId === "goose" && readiness !== "ready" && !isSelected) {
      return;
    }
    const setupAction =
      readiness === "ready"
        ? undefined
        : readiness === "not_installed" && catalogEntry?.supportsInstall
          ? "install"
          : "connect";

    visible.set(resolvedId, {
      id: resolvedId,
      label: catalogEntry?.displayName ?? label,
      readiness,
      ...(setupAction ? { setupAction } : {}),
    });
  };

  for (const entry of getAgentProvidersFromEntries(options.catalogEntries)) {
    add(entry.id, entry.displayName, false);
  }
  for (const provider of options.extraProviders ?? []) {
    add(provider.id, provider.label, true);
  }

  const selectedAgentId = options.selectedAgentId;
  if (selectedAgentId && !visible.has(selectedAgentId)) {
    add(selectedAgentId, selectedAgentId, true);
  }

  return [...visible.values()];
}
