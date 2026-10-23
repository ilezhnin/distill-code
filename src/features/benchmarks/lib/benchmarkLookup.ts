/** Index repeated lookups without changing Array.find's first-match semantics. */
export function firstById<T extends { id: string }>(
  entries: readonly T[],
): Map<string, T> {
  const index = new Map<string, T>();
  for (const entry of entries) {
    if (!index.has(entry.id)) index.set(entry.id, entry);
  }
  return index;
}
