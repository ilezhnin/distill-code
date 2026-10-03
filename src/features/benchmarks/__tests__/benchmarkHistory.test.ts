import { describe, expect, it } from "vitest";
import { historyMeasurements } from "../lib/benchmarkHistory";
import { configurationKey } from "../lib/benchmarkBoards";
import { historySegments } from "../ui/PointsHistoryChart";
import type { HistorySnapshot } from "../hooks/useBenchmarks";
import { cohort, configuration, leaderboardRow } from "./fixtures";

function snapshot(
  id: string,
  versions: string[],
  points: number,
  planned = 66,
): HistorySnapshot {
  return {
    runId: id,
    createdAt: Number(id),
    report: {
      cohort,
      rows: [
        leaderboardRow({
          points,
          scored: versions.length,
          planned,
          status: "preliminary",
          scoredVersionIds: versions,
          attemptIds: versions.map((v) => `${id}-${v}`),
        }),
      ],
    },
  };
}
const key = configurationKey(configuration);
function segments(snapshots: HistorySnapshot[]) {
  return historySegments(
    historyMeasurements(snapshots, key).map(({ snapshot: s, row, series }) => ({
      id: s.runId,
      at: s.createdAt,
      points: row.points,
      scored: row.scored,
      planned: row.planned,
      series,
    })),
  ).map((group) => group.map((point) => point.points));
}

describe("ledger history comparability", () => {
  it("defaults to the aligned pool, preserves recorded scores and folds review-only events", () => {
    const first = snapshot("1", ["a"], 0);
    const later = snapshot("2", ["a", "b"], 500);
    first.recalculatedReport = {
      cohort,
      rows: [
        leaderboardRow({
          points: 500,
          scored: 2,
          scoredVersionIds: ["a", "b"],
          attemptIds: ["first-a", "later-b"],
        }),
      ],
    };
    first.backfilledVersionIds = ["b"];
    later.recalculatedReport = first.recalculatedReport;
    later.backfilledVersionIds = [];
    const review = { ...first, id: "review", createdAt: 1.5 };
    expect(
      historyMeasurements([first, review, later], key).map((e) => e.row.points),
    ).toEqual([500, 500]);
    expect(
      historyMeasurements([first, later], key, true).map((e) => e.row.points),
    ).toEqual([0, 500]);
    first.recalculatedReport = { cohort, rows: [] };
    expect(historyMeasurements([first, later], key)).toHaveLength(1);
  });
  it("does not draw through a snapshot with no score", () => {
    const missing = snapshot("2", [], 0);
    missing.report.rows[0].points = null;
    expect(
      segments([snapshot("1", ["a"], 500), missing, snapshot("3", ["a"], 750)]),
    ).toEqual([[500], [750]]);
  });
  it("keeps the partial observations but only connects the repeated 23-case measurement", () => {
    const cases = Array.from({ length: 23 }, (_, i) => `v${i}`);
    expect(
      segments([
        snapshot("1", cases.slice(0, 1), 0),
        snapshot("2", cases.slice(0, 14), 929),
        snapshot("3", cases, 957),
        snapshot("4", cases, 870),
      ]),
    ).toEqual([[0], [929], [957, 870]]);
  });
  it("compares exact versions, including equal-sized replacements and reordered lists", () => {
    expect(
      segments([
        snapshot("1", ["a", "b"], 500),
        snapshot("2", ["b", "a"], 750),
        snapshot("3", ["a", "b-v2"], 1000),
        snapshot("4", ["a", "c"], 0),
      ]),
    ).toEqual([[500, 750], [1000], [0]]);
  });
  it("adding an unmeasured case changes coverage without breaking the measured series", () => {
    expect(
      segments([snapshot("1", ["a"], 500, 1), snapshot("2", ["a"], 500, 2)]),
    ).toEqual([[500, 500]]);
  });
  it("does not add points for runs that leave this model's evidence unchanged", () => {
    const first = snapshot("1", ["a"], 500);
    const unchanged = { ...first, runId: "other-model", createdAt: 2 };
    expect(historyMeasurements([first, unchanged], key)).toHaveLength(1);
    expect(
      historyMeasurements([first, snapshot("3", ["a"], 500)], key),
    ).toHaveLength(2);
  });
  it("starts a separate segment after a runtime revision", () => {
    const later = snapshot("2", ["a"], 750);
    later.report.rows[0].configuration = {
      ...configuration,
      inventoryRevision: "new-runtime",
    };
    expect(segments([snapshot("1", ["a"], 500), later])).toEqual([
      [500],
      [750],
    ]);
  });
});
