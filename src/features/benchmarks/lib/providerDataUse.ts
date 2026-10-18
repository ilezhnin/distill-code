import type { ProviderDataUse } from "../types";

/** The one split a provider that may train on submitted data receives. */
export const TRAIN_SPLIT = "train";

/**
 * What the service says of `providerId` when it may train on submitted
 * data; null when it does not, or while its data use is not read yet.
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

/** Whether a provider that may train on submitted data receives `split`. */
export function trainingProviderReceives(split: string): boolean {
  return split === TRAIN_SPLIT;
}
