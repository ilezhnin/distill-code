import {
  resolveSessionModelPreference,
  sanitizeSessionModelPreference,
  type SessionModelPreference,
} from "@/features/chat/lib/sessionModelPreference";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";

/**
 * The stored model preference for a harness, dropped when the harness has
 * reported its model list and the stored id is not on it. An unreported list
 * is not evidence the model is gone, so the preference stands until then.
 */
export async function resolveSupportedSessionModelPreference(
  providerId: string,
  preferredModel?: string,
): Promise<SessionModelPreference> {
  const preference = resolveSessionModelPreference({
    providerId,
    preferredModel,
  });
  if (!preference.modelId) {
    return preference;
  }

  const modelCache = useProviderModelCacheStore.getState();
  if (!modelCache.isModelInventoryAuthoritative(preference.providerId)) {
    return preference;
  }
  return sanitizeSessionModelPreference(preference, {
    models: modelCache.getModelsForProvider(preference.providerId),
  });
}
