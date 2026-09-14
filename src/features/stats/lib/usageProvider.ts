import { getCatalogEntry } from "@/features/providers/providerCatalog";
import type { SessionExecutionTarget } from "@/features/chat/lib/sessionExecutionTarget";
import { formatProviderLabel } from "@/shared/ui/icons/ProviderIcons";
import { DEFAULT_HARNESS_ID } from "@/features/providers/curatedProviders";
import {
  baseModelId,
  splitLegacyFoldedModelId,
} from "@/shared/lib/foldedModelId";

export function providerIdFromExecutionTarget(
  target: SessionExecutionTarget | null | undefined,
): string {
  return target?.harnessId ?? DEFAULT_HARNESS_ID;
}

export function modelIdFromExecutionTarget(
  target: SessionExecutionTarget | null | undefined,
): string | null {
  return target && "modelId" in target && target.modelId
    ? target.modelId
    : null;
}

export function modelNameFromExecutionTarget(
  target: SessionExecutionTarget | null | undefined,
): string | null {
  if (!target) return null;
  if ("modelName" in target && target.modelName) return target.modelName;
  if ("modelId" in target && target.modelId) return target.modelId;
  return null;
}

/** The model a usage row counts toward, and the name to show it under. */
export interface UsageModelBucket {
  key: string;
  label: string;
  /** Whether `label` is a model name rather than an id standing in for one. */
  named: boolean;
}

/**
 * Buckets a usage row by model identity.
 *
 * Rows written while an effort was folded into the model id —
 * `gpt-5.6-sol[low]` — stay as they were written, so the fold is undone here:
 * an effort is not a different model, and counting it as one split a model's
 * usage across as many buckets as it had tiers. Such a row's stored name
 * carries the tier too ("GPT-5.6 Sol (low)"), so it is labelled by its base id
 * and yields to a name from any row written since.
 */
export function usageModelBucket(record: {
  modelId: string | null;
  modelName: string | null;
}): UsageModelBucket | null {
  const modelId = baseModelId(record.modelId);
  if (!modelId) {
    return record.modelName
      ? { key: record.modelName, label: record.modelName, named: true }
      : null;
  }
  if (splitLegacyFoldedModelId(record.modelId) || !record.modelName) {
    return { key: modelId, label: modelId, named: false };
  }
  return { key: modelId, label: record.modelName, named: true };
}

export function providerDisplayName(providerId: string): string {
  return (
    getCatalogEntry(providerId)?.displayName ?? formatProviderLabel(providerId)
  );
}
