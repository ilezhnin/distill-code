function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

export function pickUniqueDisplayName(
  base: string,
  used: Iterable<string>,
): string {
  const trimmed = base.trim() || "Agent";
  const usedSet = new Set(
    [...used].map(normalizeName).filter((name) => name.length > 0),
  );
  if (!usedSet.has(normalizeName(trimmed))) {
    return trimmed;
  }
  let suffix = 2;
  while (usedSet.has(normalizeName(`${trimmed} ${suffix}`))) {
    suffix += 1;
  }
  return `${trimmed} ${suffix}`;
}
