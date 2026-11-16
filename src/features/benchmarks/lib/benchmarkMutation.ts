/**
 * What a share-scored suite evaluation records under `details.mutation`: how
 * many correct implementations the suite accepted, how many defective ones it
 * caught, and the ones it got wrong by bundle and place.
 */
export interface MutationShare {
  correctAccepted: number;
  correctTotal: number;
  defectsCaught: number;
  defectTotal: number;
  /** Defective implementations the suite did not reject, as "bundle.place". */
  missed: string[];
  /** Correct implementations the suite did not accept, as "bundle.place". */
  refused: string[];
}

const count = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;

/** The counts of a share-scored evaluation, or null for any other one. */
export function mutationShare(
  details: Record<string, unknown> | null | undefined,
): MutationShare | null {
  const mutation = details?.mutation;
  if (!mutation || typeof mutation !== "object" || Array.isArray(mutation))
    return null;
  const record = mutation as Record<string, unknown>;
  const correctAccepted = count(record.correctAccepted);
  const correctTotal = count(record.correctTotal);
  const defectsCaught = count(record.defectsCaught);
  const defectTotal = count(record.defectTotal);
  if (
    correctAccepted === null ||
    correctTotal === null ||
    defectsCaught === null ||
    defectTotal === null
  )
    return null;
  const missed: string[] = [];
  const refused: string[] = [];
  const implementations = Array.isArray(record.implementations)
    ? record.implementations
    : [];
  for (const entry of implementations) {
    if (!entry || typeof entry !== "object") continue;
    const verdict = entry as Record<string, unknown>;
    const bundle = count(verdict.case);
    const place = count(verdict.position);
    if (bundle === null || place === null || verdict.matched !== false)
      continue;
    // Counted from one, as a reader counts bundles and their implementations.
    const name = `${bundle + 1}.${place + 1}`;
    if (verdict.expected === "accept") refused.push(name);
    else if (verdict.expected === "reject") missed.push(name);
  }
  return {
    correctAccepted,
    correctTotal,
    defectsCaught,
    defectTotal,
    missed,
    refused,
  };
}
