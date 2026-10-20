import type { ProviderDataUse } from "../types";

/**
 * What the service says of `providerId` when it may train on submitted
 * data, so its models never judge; null when it does not, or while its data
 * use is not read yet. Every provider runs every split as a candidate.
 */
export function trainingProvider(
  rows: readonly ProviderDataUse[] | undefined,
  providerId: string,
): ProviderDataUse | null {
  return (
    rows?.find(
      (row) => row.providerId === providerId && row.trainsOnSubmissions,
    ) ?? null
  );
}
