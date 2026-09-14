import { useCallback, useMemo } from "react";
import { useAgentStore } from "../stores/agentStore";
import { selectSelectedProvider } from "../stores/agentSelectors";
import { useAgentProviderStatus } from "@/features/providers/hooks/useAgentProviderStatus";
import { resolveAgentProviderCatalogIdStrictFromEntries } from "@/features/providers/providerCatalog";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { DEFAULT_HARNESS_ID } from "@/features/providers/curatedProviders";
import { mostRecentlyConnectedProvider } from "@/features/providers/lib/providerConnections";

export function useProviderSelection() {
  const allProviders = useAgentStore((s) => s.providers);
  const providersLoading = useAgentStore((s) => s.providersLoading);
  const storedSelectedProvider = useAgentStore(selectSelectedProvider);
  const selectedProviderChosen = useAgentStore((s) => s.selectedProviderChosen);
  const storeSetSelectedProvider = useAgentStore((s) => s.setSelectedProvider);
  const catalogEntries = useProviderCatalogStore((state) => state.entries);
  const catalogLoaded = useProviderCatalogStore((state) => state.loaded);
  const { loading: readyAgentsLoading, readyAgentIds } =
    useAgentProviderStatus();

  const providers = allProviders;

  const selectedProvider = useMemo(() => {
    // Nothing was ever chosen: start on the account connected most recently.
    if (catalogLoaded && !selectedProviderChosen && readyAgentIds.size > 0) {
      return mostRecentlyConnectedProvider(readyAgentIds, DEFAULT_HARNESS_ID);
    }
    const selectedAgentId = resolveAgentProviderCatalogIdStrictFromEntries(
      catalogEntries,
      storedSelectedProvider,
    );
    // Selection is preference, not readiness. Session creation resolves stale
    // or unavailable implicit preferences through the shared target resolver.
    return (
      selectedAgentId ??
      (catalogLoaded ? DEFAULT_HARNESS_ID : storedSelectedProvider)
    );
  }, [
    catalogEntries,
    catalogLoaded,
    readyAgentIds,
    selectedProviderChosen,
    storedSelectedProvider,
  ]);

  const setSelectedProvider = useCallback(
    (providerId: string) => {
      storeSetSelectedProvider(providerId, true);
    },
    [storeSetSelectedProvider],
  );

  const setSelectedProviderWithoutPersist = useCallback(
    (providerId: string) => {
      storeSetSelectedProvider(providerId, false);
    },
    [storeSetSelectedProvider],
  );

  return {
    providers,
    providersLoading: providersLoading || readyAgentsLoading,
    selectedProvider,
    setSelectedProvider,
    setSelectedProviderWithoutPersist,
  };
}
