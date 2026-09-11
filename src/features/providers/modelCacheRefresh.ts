import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { getProviderCatalog } from "./providerCatalog";

/** Harnesses whose model list the app polls through the host. */
export function getModelCacheRefreshProviderIds(
  catalogEntries: ProviderCatalogEntry[] = getProviderCatalog(),
): string[] {
  return catalogEntries
    .filter((provider) => provider.supportsModelList !== false)
    .map((provider) => provider.id);
}
