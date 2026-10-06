import { describe, expect, it } from "vitest";
import {
  liveVersionIds,
  nextReleaseName,
  poolChanges,
} from "../lib/benchmarkReleases";
import type { BenchmarkDefinition, BenchmarkVersion } from "../types";
import { definition } from "./fixtures";

function test(
  id: string,
  versions: [string, number][],
  archived = false,
): BenchmarkDefinition {
  return {
    ...definition,
    id,
    archived,
    versions: versions.map(
      ([version, publishedAt]): BenchmarkVersion => ({
        ...definition.versions[0],
        id: version,
        definitionId: id,
        publishedAt,
      }),
    ),
  };
}

describe("pool releases", () => {
  const tests = [
    test("a", [
      ["a1", 1],
      ["a2", 5],
    ]),
    test("b", [["b1", 2]]),
    test("c", [["c1", 3]], true),
    test("d", [["d1", 4]]),
  ];

  it("freezes every live test's newest version", () => {
    expect(liveVersionIds(tests)).toEqual(["a2", "b1", "d1"]);
  });

  it("counts new, revised and retired tests against the previous release", () => {
    expect(poolChanges(tests, ["a1", "b1", "c1"], ["a2", "b1", "d1"])).toEqual({
      added: 1,
      revised: 1,
      retired: 1,
    });
    expect(poolChanges(tests, [], ["a2", "b1"])).toEqual({
      added: 2,
      revised: 0,
      retired: 0,
    });
  });

  it("reads an evaluator-only republication as the version it carries", () => {
    const carried = [
      ...tests,
      {
        ...test("a", [["a3", 6]]),
        versions: [
          {
            ...tests[0].versions[1],
            id: "a3",
            publishedAt: 6,
            carriesFrom: "a2",
          },
        ],
      },
    ];
    expect(poolChanges(carried, ["a2", "b1"], ["a3", "b1"])).toEqual({
      added: 0,
      revised: 0,
      retired: 0,
    });
  });

  it("names the next release as the service does", () => {
    expect(nextReleaseName([])).toBe("v1");
    expect(
      nextReleaseName([
        { id: "r", name: "first", createdAt: 1, versionIds: [] },
      ]),
    ).toBe("v2");
  });
});
