import { DEFAULT_HARNESS_ID } from "@/features/providers/curatedProviders";
import { resolveAgentProviderCatalogIdStrictFromEntries } from "@/features/providers/providerCatalog";
import type { ProviderCatalogEntry } from "@/shared/types/providers";

interface ResolveSelectedAgentIdOptions {
  catalogEntries: ProviderCatalogEntry[];
  selectedProvider?: string;
  catalogLoaded?: boolean;
}

export function resolveSelectedAgentId({
  catalogEntries,
  selectedProvider,
  catalogLoaded = true,
}: ResolveSelectedAgentIdOptions): string {
  if (!selectedProvider) {
    return DEFAULT_HARNESS_ID;
  }

  const resolvedAgentId = resolveAgentProviderCatalogIdStrictFromEntries(
    catalogEntries,
    selectedProvider,
  );
  if (resolvedAgentId) {
    return resolvedAgentId;
  }

  if (!catalogLoaded) {
    return selectedProvider;
  }

  return DEFAULT_HARNESS_ID;
}
