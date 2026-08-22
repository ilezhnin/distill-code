import { getCatalogEntry } from "@/features/providers/providerCatalog";
import type { SessionExecutionTarget } from "@/features/chat/lib/sessionExecutionTarget";
import { formatProviderLabel } from "@/shared/ui/icons/ProviderIcons";

export function providerIdFromExecutionTarget(
  target: SessionExecutionTarget | null | undefined,
): string {
  return target?.harnessId ?? "goose";
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

export function providerDisplayName(providerId: string): string {
  return (
    getCatalogEntry(providerId)?.displayName ?? formatProviderLabel(providerId)
  );
}
