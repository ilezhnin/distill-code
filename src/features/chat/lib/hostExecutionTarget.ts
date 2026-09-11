import {
  CURATED_PROVIDER_CATALOG,
  DEFAULT_HARNESS_ID,
} from "@/features/providers/curatedProviders";
import { canonicalProviderCatalogIdFromEntries } from "@/features/providers/providerCatalog";
import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";
import {
  normalizeSessionExecutionTarget,
  type SessionExecutionTarget,
} from "./sessionExecutionTarget";

/** The provider/model pair as the host and persisted records spell it. */
export interface HostSessionSelection {
  providerId?: string;
  modelId?: string;
  modelName?: string;
}

function canonicalProviderId(providerId: string): string {
  return canonicalProviderCatalogIdFromEntries(
    CURATED_PROVIDER_CATALOG,
    providerId,
  );
}

function targetFor(
  harnessId: string,
  modelId?: string,
  modelName?: string,
): SessionExecutionTarget {
  const concreteModelId = normalizeConcreteModelId(modelId);
  return normalizeSessionExecutionTarget({
    harnessId,
    modelProviderId: concreteModelId ? harnessId : undefined,
    modelId: concreteModelId,
    modelName,
  });
}

export function hostSelectionFromExecutionTarget(
  target: SessionExecutionTarget | null | undefined,
): HostSessionSelection {
  if (!target) {
    return {};
  }
  return {
    providerId: target.harnessId,
    modelId: target.modelId,
    modelName: target.modelName,
  };
}

/** Converts untrusted persisted/ACP provider fields into a canonical target. */
export function executionTargetFromHostBoundary(
  selection: HostSessionSelection,
  fallbackTarget?: SessionExecutionTarget,
): SessionExecutionTarget {
  const providerId = selection.providerId ?? fallbackTarget?.harnessId;
  if (!providerId) {
    return targetFor(DEFAULT_HARNESS_ID);
  }
  // A model without any provider identity is not actionable. Ignore it
  // instead of letting one legacy record abort queue/session hydration.
  return targetFor(
    canonicalProviderId(providerId),
    selection.modelId,
    selection.modelName,
  );
}

/** Converts ACP discovery metadata without inventing a renderer-owned target. */
export function executionTargetFromHostSession(
  selection: HostSessionSelection,
): SessionExecutionTarget | undefined {
  if (!selection.providerId) {
    return undefined;
  }
  return targetFor(
    canonicalProviderId(selection.providerId),
    selection.modelId,
    selection.modelName,
  );
}
