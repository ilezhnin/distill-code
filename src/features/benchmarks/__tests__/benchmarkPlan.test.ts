import { describe, expect, it } from "vitest";
import { plannedTurns } from "../lib/benchmarkPlan";
import type { BenchmarkAuthor, BenchmarkVersion } from "../types";
import { configuration, definition } from "./fixtures";

const version = definition.versions[0];
const caseOf = (
  kind: string,
  authoredBy?: BenchmarkAuthor[],
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
  it("reserves exact frozen seats once for the complete workflow", () => {
    const task = caseOf("rubric", undefined, 2);
    task.manifest.environment = {
      judgePanel: { recipe: "frozen-native-panel-v1", judges: [{}, {}] },
    };
    expect(plannedTurns([task])).toBe(4);
  });
  it("counts every step and a judged case's panel, cases the candidate wrote included", () => {
    expect(
      plannedTurns([
        caseOf("exact"),
        caseOf("rubric"),
        caseOf("exact", undefined, 3),
        caseOf("rubric", [{ ...configuration, modelId: "MODEL-1" }]),
        caseOf("exact", [configuration]),
      ]),
    ).toBe(1 + 4 + 3 + 4 + 1);
  });
});
