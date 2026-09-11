/** A blank id means no concrete model was chosen. */
export function normalizeConcreteModelId(
  modelId: string | null | undefined,
): string | undefined {
  const normalized = modelId?.trim();
  return normalized ? normalized : undefined;
}
