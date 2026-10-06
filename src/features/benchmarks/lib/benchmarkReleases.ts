import type { BenchmarkDefinition, PoolRelease } from "../types";

/** Every live test's newest published version: what the next release freezes. */
export function liveVersionIds(definitions: BenchmarkDefinition[]): string[] {
  return definitions
    .filter((definition) => !definition.archived)
    .flatMap((definition) =>
      [...definition.versions]
        .sort((a, b) => b.publishedAt - a.publishedAt)
        .slice(0, 1)
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
  const testOf = new Map(
    definitions.flatMap((definition) =>
      definition.versions.map(
        (version) => [version.id, definition.id] as const,
      ),
    ),
  );
  const byTest = (ids: string[]) =>
    new Map(ids.map((id) => [testOf.get(id) ?? id, id] as const));
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
