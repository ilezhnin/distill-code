import { useCallback, useMemo } from "react";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import type { ModelOption } from "@/features/chat/types";
import { filterModelProvidersForRuntimeConfig } from "../runtimeProviderConstraints";
import { getModelProvidersFromEntries } from "../providerCatalog";
import { getModelCacheRefreshProviderIds } from "../modelCacheRefresh";
import { getProviderModelSelectionHint } from "../modelSelectionHints";
import { isGooseModelProviderId } from "../lib/modelRecommendations";
import { defaultModelInventoryModeForLoadResult } from "../runtimeProviderConfig";
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
  const runtimeConfig = useRuntimeConfigStore((state) => state.config);
  const runtimeConfigResult = useRuntimeConfigStore((state) => state.result);
  const catalogEntries = useProviderCatalogStore((state) => state.entries);

  const configuredModelProviderIds = useMemo(
    () =>
      filterModelProvidersForRuntimeConfig(
        getModelProvidersFromEntries(catalogEntries),
        runtimeConfig,
      ).map((p) => p.id),
    [catalogEntries, runtimeConfig],
  );
  const runtimeModelMetadataByProviderId = useMemo(
    () =>
      new Map(
        runtimeConfig.goose.modelProviders.map((provider) => [
          provider.id,
          new Map(
            provider.models.map((model) => [
              model.id,
              {
                recommended: model.recommended ?? false,
                featured: model.featured ?? false,
              },
            ]),
          ),
        ]),
      ),
    [runtimeConfig],
  );
  const customProviderIds = useMemo(
    () =>
      getModelProvidersFromEntries(catalogEntries)
        .filter((provider) => provider.customProvider === true)
        .map((provider) => provider.id),
    [catalogEntries],
  );
  const modelCacheRefreshProviderIds = useMemo(
    () =>
      getModelCacheRefreshProviderIds(runtimeConfig, {
        defaultModelInventoryMode:
          defaultModelInventoryModeForLoadResult(runtimeConfigResult),
        catalogEntries,
        // Connected first-class providers refresh at startup and immediately
        // after setup. Picker-open refreshes must not probe unconfigured OAuth
        // providers, which can launch external sign-in flows.
        configuredProviderIds: customProviderIds,
      }),
    [catalogEntries, customProviderIds, runtimeConfig, runtimeConfigResult],
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

  const modelsForAgent = useCallback(
    (
      agentId: string,
      { authoritativeOnly }: { authoritativeOnly: boolean },
    ) => {
      if (agentId !== "goose") {
        if (authoritativeOnly && !isModelInventoryAuthoritative(agentId)) {
          return EMPTY_MODELS;
        }
        return getModelsForProvider(agentId);
      }

      return configuredModelProviderIds
        .filter(
          (providerId) =>
            !authoritativeOnly || isModelInventoryAuthoritative(providerId),
        )
        .flatMap((providerId) => {
          const models = providers.get(providerId)?.models ?? [];
          if (isGooseModelProviderId(providerId)) {
            return models;
          }

          // Goose combines every available provider into one searchable
          // catalog. Only explicitly curated runtime models keep recommendation
          // metadata; provider-local discovery must not expand the combined
          // shortlist.
          const runtimeModelMetadata =
            runtimeModelMetadataByProviderId.get(providerId);
          return models.map((model) => {
            const curatedMetadata = runtimeModelMetadata?.get(model.id);
            return {
              ...model,
              recommended: curatedMetadata?.recommended ?? false,
              featured: curatedMetadata?.featured ?? false,
            };
          });
        });
    },
    [
      configuredModelProviderIds,
      getModelsForProvider,
      isModelInventoryAuthoritative,
      providers,
      runtimeModelMetadataByProviderId,
    ],
  );

  /** Everything the operator may see and pick, authoritative or not. */
  const getModelsForAgent = useCallback(
    (agentId: string) => modelsForAgent(agentId, { authoritativeOnly: false }),
    [modelsForAgent],
  );

  /**
   * Only models a provider has actually reported — for callers that PIN a
   * session to a concrete model id.
   *
   * The two questions differ. A picker asks "what may the operator choose",
   * and keeping the last known list on screen while a refresh is in flight is
   * right there. Starting a session asks "what will the harness accept", and
   * since the cache stopped clearing itself on an empty discovery result
   * (a refresh that answers nothing now keeps the previous payload as a
   * retryable non-answer) a stale list can name models the harness no longer
   * serves. Goose forwards such an id to the ACP agent verbatim, the agent
   * answers `Invalid params`, and every send in that chat dies on "Failed to
   * set ACP model option" — from `stream()`, so the chat cannot be rescued
   * from inside itself.
   *
   * `isCachedModelInventoryAuthoritative` is the cache's own word for "this
   * payload is an answer, not a leftover", so a non-authoritative provider is
   * reported here as one that lists nothing: unknown, not installed. The
   * caller then starts the session on the harness' own current model, which
   * always works, instead of on an id nothing can serve (D5 — the fallback is
   * "no model named", never a different concrete model).
   */
  const getInstalledModelsForAgent = useCallback(
    (agentId: string) => modelsForAgent(agentId, { authoritativeOnly: true }),
    [modelsForAgent],
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

  return {
    configuredModelProviderIds,
    modelCacheRefreshProviderIds,
    getModelsForAgent,
    getInstalledModelsForAgent,
    getModelsForProvider,
    isModelInventoryAuthoritative,
    refreshProviderModels,
    refreshAllModelProviders,
    isRefreshingProvider,
    getError,
  };
}
