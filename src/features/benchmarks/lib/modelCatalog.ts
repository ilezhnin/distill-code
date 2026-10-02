// Effective-dated model facts resolved at measurement time, so a price change
// adds an entry and old boards keep the price that applied when they ran.
import type { CatalogEntry, Configuration } from "../types";

function matches(
  entry: CatalogEntry,
  configuration: Pick<Configuration, "providerId" | "modelId">,
  name: string | null | undefined,
): boolean {
  if (entry.providerId && entry.providerId !== configuration.providerId)
    return false;
  const haystack = `${name ?? ""} ${configuration.modelId}`.toLowerCase();
  return haystack.includes(entry.needle.toLowerCase());
}

/**
 * The entry that applied at `at`: the latest effective date not after it.
 * Nothing resolves when every matching entry starts later than the
 * measurement; a price recorded afterwards is not evidence about that run.
 */
export function resolveCatalogEntry(
  entries: CatalogEntry[],
  configuration: Pick<Configuration, "providerId" | "modelId">,
  name: string | null | undefined,
  at: number | null | undefined,
): CatalogEntry | null {
  const moment = at ?? Number.POSITIVE_INFINITY;
  let best: CatalogEntry | null = null;
  for (const entry of entries) {
    if (entry.kind !== "model" || !matches(entry, configuration, name))
      continue;
    if (entry.effectiveFrom > moment) continue;
    if (
      !best ||
      entry.effectiveFrom > best.effectiveFrom ||
      (entry.effectiveFrom === best.effectiveFrom &&
        entry.createdAt > best.createdAt)
    )
      best = entry;
  }
  return best;
}

function money(value: number): string {
  return `$${Number(value.toPrecision(3)).toString()}`;
}

/** "$4 / $20" for input and output list prices per million tokens. */
export function formatPrice(entry: CatalogEntry | null): string | null {
  if (!entry || entry.inputPerMillion == null || entry.outputPerMillion == null)
    return null;
  return `${money(entry.inputPerMillion)} / ${money(entry.outputPerMillion)}`;
}

/** "1M", "1.05M", "500K", "200K". */
export function formatContext(
  tokens: number | null | undefined,
): string | null {
  if (tokens == null || tokens <= 0) return null;
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number(millions.toFixed(2)).toString()}M`;
  }
  return `${Math.round(tokens / 1_000)}K`;
}

/** The most recent check date across the catalog, for the summary line. */
export function latestCheckedAt(entries: CatalogEntry[]): number | null {
  return entries.reduce<number | null>(
    (latest, entry) =>
      latest == null || entry.checkedAt > latest ? entry.checkedAt : latest,
    null,
  );
}
