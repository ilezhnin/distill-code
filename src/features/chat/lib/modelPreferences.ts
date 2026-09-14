import {
  canonicalProviderCatalogId,
  resolveAgentProviderCatalogIdStrict,
} from "@/features/providers/providerCatalog";
import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";
import {
  baseModelId,
  splitLegacyFoldedModelId,
} from "@/shared/lib/foldedModelId";
import { isRecord } from "@/shared/lib/isRecord";

const MODEL_PREFERENCES_STORAGE_KEY = "distill:preferredModelsByAgent";

/** The two model-scoped knobs an agent's preferred model is remembered with. */
export interface StoredModelRunSettings {
  /** The harness's own effort value id ("xhigh", "ultra"), never an app enum. */
  reasoningEffort?: string;
  fastMode?: boolean;
}

export interface StoredModelPreference extends StoredModelRunSettings {
  modelId: string;
  modelName: string;
  providerId?: string;
  /**
   * Per-model overrides, because the agent-level value is not offered by every
   * model: Opus 4.6 has no xhigh, Haiku has no effort control at all.
   */
  byModel?: Record<string, StoredModelRunSettings>;
}

type StoredModelPreferences = Record<string, StoredModelPreference>;

function parseStoredRunSettings(value: unknown): StoredModelRunSettings {
  if (!isRecord(value)) {
    return {};
  }
  const reasoningEffort =
    typeof value.reasoningEffort === "string"
      ? value.reasoningEffort.trim()
      : undefined;
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(typeof value.fastMode === "boolean"
      ? { fastMode: value.fastMode }
      : {}),
  };
}

function parseStoredByModel(
  value: unknown,
): Record<string, StoredModelRunSettings> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const byModel: Record<string, StoredModelRunSettings> = {};
  for (const [storedModelId, candidate] of Object.entries(value)) {
    const modelId = baseModelId(storedModelId);
    if (!modelId) continue;
    const settings = parseStoredRunSettings(candidate);
    if (
      settings.reasoningEffort === undefined &&
      settings.fastMode === undefined
    )
      continue;
    byModel[modelId] = settings;
  }
  return Object.keys(byModel).length > 0 ? byModel : undefined;
}

function canonicalAgentId(agentId: string): string {
  return resolveAgentProviderCatalogIdStrict(agentId) ?? agentId;
}

function canonicalModelProviderId(providerId: string): string | undefined {
  return providerId ? canonicalProviderCatalogId(providerId) : undefined;
}

function parseStoredModelPreferences(value: unknown): StoredModelPreferences {
  if (!isRecord(value)) {
    return {};
  }

  const preferences: StoredModelPreferences = {};
  for (const [storedAgentId, candidate] of Object.entries(value)) {
    if (!isRecord(candidate)) continue;
    const agentId = canonicalAgentId(storedAgentId);
    const storedModelId =
      typeof candidate.modelId === "string"
        ? normalizeConcreteModelId(candidate.modelId)
        : undefined;
    const storedProviderId =
      typeof candidate.providerId === "string"
        ? canonicalModelProviderId(candidate.providerId)
        : undefined;
    const providerId = storedProviderId ?? agentId;
    if (!storedModelId) continue;

    // A preference written before model and effort were separate selections
    // holds both in one id. Read them apart here, so an inventory of base ids
    // cannot drop the entry as an unknown model; an explicitly stored effort
    // wins, and the split form is written back only on the next save.
    const folded = splitLegacyFoldedModelId(storedModelId);
    const modelId = folded?.modelId ?? storedModelId;
    const runSettings = parseStoredRunSettings(candidate);
    const reasoningEffort = runSettings.reasoningEffort ?? folded?.effort;
    const byModel = parseStoredByModel(candidate.byModel);

    preferences[agentId] = {
      modelId,
      modelName:
        typeof candidate.modelName === "string" ? candidate.modelName : modelId,
      ...(providerId ? { providerId } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(runSettings.fastMode !== undefined
        ? { fastMode: runSettings.fastMode }
        : {}),
      ...(byModel ? { byModel } : {}),
    };
  }
  return preferences;
}

function readStoredModelPreferences(): StoredModelPreferences {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const stored = window.localStorage.getItem(MODEL_PREFERENCES_STORAGE_KEY);
    if (!stored) {
      return {};
    }

    return parseStoredModelPreferences(JSON.parse(stored));
  } catch {
    return {};
  }
}

function persistStoredModelPreferences(
  preferences: StoredModelPreferences,
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (Object.keys(preferences).length === 0) {
      window.localStorage.removeItem(MODEL_PREFERENCES_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(
      MODEL_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch {
    // localStorage may be unavailable
  }
}

export function getStoredModelPreference(
  agentId: string,
): StoredModelPreference | null {
  return readStoredModelPreferences()[canonicalAgentId(agentId)] ?? null;
}

export function getStoredModelPreferenceForProvider(
  providerId: string,
): StoredModelPreference | null {
  const exactPreference = getStoredModelPreference(providerId);
  if (exactPreference) {
    return exactPreference;
  }

  return getStoredModelPreference(
    resolveAgentProviderCatalogIdStrict(providerId) ?? providerId,
  );
}

export function setStoredModelPreference(
  agentId: string,
  preference: StoredModelPreference,
): void {
  const next = readStoredModelPreferences();
  const canonicalId = canonicalAgentId(agentId);
  const modelId = normalizeConcreteModelId(preference.modelId);
  const providerId = preference.providerId
    ? canonicalModelProviderId(preference.providerId)
    : undefined;
  if (!modelId || !providerId) {
    delete next[canonicalId];
    persistStoredModelPreferences(next);
    return;
  }
  next[canonicalId] = { ...preference, modelId, providerId };
  persistStoredModelPreferences(next);
}

export function clearStoredModelPreference(agentId: string): void {
  const next = readStoredModelPreferences();
  delete next[canonicalAgentId(agentId)];
  persistStoredModelPreferences(next);
}
