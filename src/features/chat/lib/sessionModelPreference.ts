import { resolveAgentProviderCatalogIdStrict } from "@/features/providers/providerCatalog";
import { getStoredModelPreferenceForProvider } from "./modelPreferences";
import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";
import { sameModelIdentity } from "@/shared/lib/foldedModelId";

interface SessionModelPreferenceOptions {
  providerId: string;
  preferredModel?: string;
}

export interface SessionModelPreference {
  providerId: string;
  modelId?: string;
  modelName?: string;
}

interface ProviderModelsLike {
  models: Array<{
    id: string;
  }>;
}

export function resolveSessionModelPreference({
  providerId,
  preferredModel,
}: SessionModelPreferenceOptions): SessionModelPreference {
  const concretePreferredModel = normalizeConcreteModelId(preferredModel);
  if (concretePreferredModel) {
    return {
      providerId,
      modelId: concretePreferredModel,
      modelName: concretePreferredModel,
    };
  }

  const storedModelPreference = getStoredModelPreferenceForProvider(providerId);
  if (!storedModelPreference) {
    return { providerId };
  }

  if (resolveAgentProviderCatalogIdStrict(providerId)) {
    return {
      providerId: storedModelPreference.providerId ?? providerId,
      modelId: storedModelPreference.modelId,
      modelName: storedModelPreference.modelName,
    };
  }

  if (
    storedModelPreference.providerId &&
    storedModelPreference.providerId !== providerId
  ) {
    return { providerId };
  }

  return {
    providerId,
    modelId: storedModelPreference.modelId,
    modelName: storedModelPreference.modelName,
  };
}

export function sanitizeSessionModelPreference(
  preference: SessionModelPreference,
  providerModels?: ProviderModelsLike | null,
): SessionModelPreference {
  if (!preference.modelId || !providerModels) {
    return preference;
  }

  if (providerModels.models.length === 0) {
    return preference;
  }

  // The advertised id and the preferred one may be written differently — one
  // folded, one not — while naming the same model. Only a model the harness no
  // longer serves at all is dropped.
  if (
    providerModels.models.some((model) =>
      sameModelIdentity(model.id, preference.modelId),
    )
  ) {
    return preference;
  }

  return {
    providerId: preference.providerId,
  };
}
