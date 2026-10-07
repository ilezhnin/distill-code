import type { BenchmarkDefinition, PoolRelease } from "../types";

/** Development fixtures remain diagnostic and never enter capability ratings. */
export function isRankedSplit(split: string): boolean {
  return split === "train" || split === "held_out";
}

/** Every live ranked test's newest version: what the next release freezes. */
export function liveVersionIds(definitions: BenchmarkDefinition[]): string[] {
  return definitions
    .filter((definition) => !definition.archived)
    .flatMap((definition) =>
      [...definition.versions]
        .sort((a, b) => b.publishedAt - a.publishedAt)
        .slice(0, 1)
        .filter((version) => isRankedSplit(version.manifest.split))
        .map((version) => version.id),
    )
    .sort();
}

export interface PoolChanges {
  added: number;
  revised: number;
  retired: number;
}

/**
 * How `next` differs from `previous`, by test: a test new to the pool, a test
 * whose version changed, and a test that left it.
 */
export function poolChanges(
  definitions: BenchmarkDefinition[],
  previous: string[],
  next: string[],
): PoolChanges {
  const versions = definitions.flatMap((definition) => definition.versions);
  const testOf = new Map(
    versions.map((version) => [version.id, version.definitionId] as const),
  );
  // A version republished with only its evaluator changed is the same
  // measurement: the release reads it through the version that carries it.
  const carriedFrom = new Map(
    versions
      .filter((version) => version.carriesFrom)
      .map((version) => [version.id, version.carriesFrom as string] as const),
  );
  const origin = (id: string) => {
    const seen = new Set<string>();
    let current = id;
    while (carriedFrom.has(current) && !seen.has(current)) {
      seen.add(current);
      current = carriedFrom.get(current) as string;
    }
    return current;
  };
  const byTest = (ids: string[]) =>
    new Map(ids.map((id) => [testOf.get(id) ?? id, origin(id)] as const));
  const before = byTest(previous);
  const after = byTest(next);
  let added = 0;
  let revised = 0;
  for (const [test, id] of after) {
    const old = before.get(test);
    if (old == null) added += 1;
    else if (old !== id) revised += 1;
  }
  const retired = [...before.keys()].filter((test) => !after.has(test)).length;
  return { added, revised, retired };
}

/** The release that follows `releases`, named as the service would. */
export function nextReleaseName(releases: PoolRelease[]): string {
  return `v${releases.length + 1}`;
}
