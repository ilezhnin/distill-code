import type { SessionModelPreference } from "@/features/chat/lib/sessionModelPreference";
import type { StoredModelPreference } from "@/features/chat/lib/modelPreferences";
import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";

export type NewSessionTargetProvenance = "explicit" | "persisted" | "fallback";

export type NewSessionTargetResult =
  | ({
      status: "ready";
      provenance: NewSessionTargetProvenance;
    } & SessionModelPreference)
  | {
      status: "blocked";
      reason: "explicit_target_unready";
      providerId: string;
    }
  | { status: "needs_setup" };

export interface NewSessionTargetSnapshot {
  readyAgentIds: ReadonlySet<string>;
  catalogAgentIds: readonly string[];
  persistedProviderId?: string | null;
  persistedModelPreference?: StoredModelPreference | null;
}

export interface NewSessionTargetRequest {
  providerId?: string;
  modelId?: string;
}

function readyTarget(
  providerId: string,
  modelId: string | undefined,
  provenance: NewSessionTargetProvenance,
): NewSessionTargetResult {
  const concreteModelId = normalizeConcreteModelId(modelId);
  return {
    status: "ready",
    provenance,
    providerId,
    modelId: concreteModelId,
    ...(concreteModelId ? { modelName: concreteModelId } : {}),
  };
}

/** Resolve one settled agent/model target for a new session. No I/O. */
export function resolveNewSessionTarget(
  snapshot: NewSessionTargetSnapshot,
  request: NewSessionTargetRequest = {},
): NewSessionTargetResult {
  const isReady = (providerId: string) =>
    snapshot.readyAgentIds.has(providerId);

  if (request.providerId) {
    return isReady(request.providerId)
      ? readyTarget(request.providerId, request.modelId, "explicit")
      : {
          status: "blocked",
          reason: "explicit_target_unready",
          providerId: request.providerId,
        };
  }

  const persistedProviderId = snapshot.persistedProviderId ?? undefined;
  if (persistedProviderId && isReady(persistedProviderId)) {
    const preference = snapshot.persistedModelPreference;
    const preferenceMatches =
      preference &&
      (!preference.providerId || preference.providerId === persistedProviderId);
    if (preferenceMatches) {
      const modelId = normalizeConcreteModelId(preference.modelId);
      return {
        status: "ready",
        provenance: "persisted",
        providerId: persistedProviderId,
        modelId,
        modelName: modelId ? preference.modelName : undefined,
      };
    }
    return readyTarget(persistedProviderId, undefined, "persisted");
  }

  const fallbackProviderId = snapshot.catalogAgentIds.find(isReady);
  return fallbackProviderId
    ? readyTarget(fallbackProviderId, undefined, "fallback")
    : { status: "needs_setup" };
}
