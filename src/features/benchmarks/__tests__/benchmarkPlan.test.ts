import { describe, expect, it } from "vitest";
import { plannedTurns } from "../lib/benchmarkPlan";
import type { BenchmarkVersion } from "../types";
import { configuration, definition } from "./fixtures";

const version = definition.versions[0];
const caseOf = (
  kind: string,
  authoredBy?: string[],
  steps = 0,
): BenchmarkVersion => ({
  ...version,
  manifest: {
    ...version.manifest,
    evaluator: { ...version.manifest.evaluator, kind },
    environment: authoredBy ? { authoredBy } : {},
    workflow: steps
      ? {
          ...(version.manifest.workflow ?? {}),
          steps: Array.from({ length: steps }, () => ({})),
        }
      : null,
  } as BenchmarkVersion["manifest"],
});

describe("planned turns", () => {
  it("counts every step and a judged case's panel, nothing for a case the candidate wrote", () => {
    expect(
      plannedTurns(
        [
          caseOf("exact"),
          caseOf("rubric"),
          caseOf("exact", undefined, 3),
          caseOf("rubric", ["MODEL-1"]),
          caseOf("exact", ["model-1"]),
        ],
        configuration,
      ),
    ).toBe(1 + 4 + 3);
  });
});
