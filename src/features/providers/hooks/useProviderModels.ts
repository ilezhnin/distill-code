import { useCallback, useMemo } from "react";
import type { ModelOption } from "@/features/chat/types";
import { getModelCacheRefreshProviderIds } from "../modelCacheRefresh";
import { getProviderModelSelectionHint } from "../modelSelectionHints";
import type { ProviderModelInventoryProblem } from "../lib/providerModelInventoryStatus";
import { useProviderCatalogStore } from "../stores/providerCatalogStore";
import {
  isCachedModelInventoryAuthoritative,
  useProviderModelCacheStore,
} from "../stores/providerModelCacheStore";

const EMPTY_MODELS: ModelOption[] = [];

export function useProviderModels() {
  const providers = useProviderModelCacheStore((state) => state.providers);
  const refreshingProviderIds = useProviderModelCacheStore(
    (state) => state.refreshingProviderIds,
  );
  const refreshProviderModels = useProviderModelCacheStore(
    (state) => state.refreshProviderModels,
  );
  const refreshAllModelProviders = useProviderModelCacheStore(
    (state) => state.refreshAllModelProviders,
  );
  const catalogEntries = useProviderCatalogStore((state) => state.entries);

  const modelCacheRefreshProviderIds = useMemo(
    () => getModelCacheRefreshProviderIds(catalogEntries),
    [catalogEntries],
  );

  const getModelsForProvider = useCallback(
    (providerId: string) => providers.get(providerId)?.models ?? EMPTY_MODELS,
    [providers],
  );

  const isModelInventoryAuthoritative = useCallback(
    (providerId: string) =>
      isCachedModelInventoryAuthoritative(providers.get(providerId)),
    [providers],
  );

  /** Everything the operator may see and pick, authoritative or not. */
  const getModelsForAgent = useCallback(
    (agentId: string) => getModelsForProvider(agentId),
    [getModelsForProvider],
  );

  /**
   * Only models a harness has actually reported — for callers that PIN a
   * session to a concrete model id. A stale or never-answered list can name
   * models the harness no longer serves; the harness then rejects the id on
   * every send. A non-authoritative provider is reported here as one that
   * lists nothing, so the caller starts the session on the harness' own
   * current model instead (D5: the fallback is "no model named", never a
   * different concrete model).
   */
  const getInstalledModelsForAgent = useCallback(
    (agentId: string) =>
      isModelInventoryAuthoritative(agentId)
        ? getModelsForProvider(agentId)
        : EMPTY_MODELS,
    [getModelsForProvider, isModelInventoryAuthoritative],
  );

  const isRefreshingProvider = useCallback(
    (providerId: string) => refreshingProviderIds.has(providerId),
    [refreshingProviderIds],
  );

  const getError = useCallback(
    (providerId: string) =>
      getProviderModelSelectionHint(providerId) ??
      providers.get(providerId)?.error ??
      null,
    [providers],
  );

  /**
   * Why this agent's model list is empty, when it is. A failed poll wins over
   * an empty answer. A provider that manages its own model list is not a
   * problem at all; `getError` already has a sentence for it.
   */
  const getModelInventoryProblem = useCallback(
    (agentId: string): ProviderModelInventoryProblem | null => {
      if (getProviderModelSelectionHint(agentId)) {
        return null;
      }
      const entry = providers.get(agentId);
      if (entry?.outcome === "failed") {
        return { providerId: agentId, outcome: "failed", reason: entry.error };
      }
      if (entry?.outcome === "empty") {
        return { providerId: agentId, outcome: "empty" };
      }
      return null;
    },
    [providers],
  );

  return {
    modelCacheRefreshProviderIds,
    getModelsForAgent,
    getInstalledModelsForAgent,
    getModelsForProvider,
    isModelInventoryAuthoritative,
    refreshProviderModels,
    refreshAllModelProviders,
    isRefreshingProvider,
    getError,
    getModelInventoryProblem,
  };
}
