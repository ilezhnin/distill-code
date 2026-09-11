import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import { useAgentProviderStatus } from "./useAgentProviderStatus";
import {
  resolveNewSessionTarget,
  type NewSessionTargetRequest,
  type NewSessionTargetResult,
} from "../lib/newSessionTarget";
import { useProviderCatalogStore } from "../stores/providerCatalogStore";
import { resolveSupportedSessionModelPreference } from "../lib/resolveSessionModelPreference";
import { getStoredModelPreference } from "@/features/chat/lib/modelPreferences";
import { resolveSelectedAgentId } from "@/features/chat/lib/agentProviderResolution";

export interface EnsureNewSessionTargetOptions {
  onUnavailable?: "open_settings" | "silent";
}

export function useNewSessionTarget() {
  const { t } = useTranslation();
  const {
    agentReadiness: cachedAgentReadiness,
    loading: agentReadinessLoading,
    refresh: refreshAgentReadiness,
  } = useAgentProviderStatus();

  return useCallback(
    async (
      request: NewSessionTargetRequest = {},
      options: EnsureNewSessionTargetOptions = {},
    ): Promise<NewSessionTargetResult> => {
      // New-session creation is a correctness boundary. Refresh readiness that
      // has not settled rather than allowing an initial negative cache to
      // strand the user.
      let agentReadiness = cachedAgentReadiness;
      if (agentReadinessLoading) {
        agentReadiness =
          (await refreshAgentReadiness()) ?? cachedAgentReadiness;
      }
      const catalogAgentIds = useProviderCatalogStore
        .getState()
        .entries.map((provider) => provider.id);
      const readyAgentIds = new Set(
        [...agentReadiness.entries()]
          .filter(([, readiness]) => readiness === "ready")
          .map(([providerId]) => providerId),
      );
      const persistedAgentId = resolveSelectedAgentId({
        catalogEntries: useProviderCatalogStore.getState().entries,
        catalogLoaded: useProviderCatalogStore.getState().loaded,
        selectedProvider: useAgentStore.getState().selectedProvider,
      });
      const storedModelPreference = getStoredModelPreference(persistedAgentId);
      const supportedStoredPreference = storedModelPreference
        ? await resolveSupportedSessionModelPreference(persistedAgentId)
        : null;
      const persistedModelPreference = supportedStoredPreference?.modelId
        ? {
            modelId: supportedStoredPreference.modelId,
            modelName:
              supportedStoredPreference.modelName ??
              storedModelPreference?.modelName ??
              supportedStoredPreference.modelId,
            providerId: supportedStoredPreference.providerId,
          }
        : null;
      let result = resolveNewSessionTarget(
        {
          readyAgentIds,
          catalogAgentIds,
          persistedProviderId: persistedAgentId,
          persistedModelPreference,
        },
        request,
      );
      if (
        result.status === "ready" &&
        result.provenance === "persisted" &&
        !result.modelId
      ) {
        result = {
          ...result,
          ...(await resolveSupportedSessionModelPreference(result.providerId)),
        };
      }

      if (result.status !== "ready" && options.onUnavailable !== "silent") {
        toast.info(t("settings:providers.setupRequired.toast"));
        requestOpenSettings("providers");
      }
      return result;
    },
    [agentReadinessLoading, cachedAgentReadiness, refreshAgentReadiness, t],
  );
}
