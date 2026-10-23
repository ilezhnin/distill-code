import { describe, expect, it } from "vitest";
import {
  historyMeasurements,
  modelHistoryMeasurements,
} from "../lib/benchmarkHistory";
import {
  configurationKey,
  rowKey,
  rankRows,
  boardsFor,
} from "../lib/benchmarkBoards";
import { modelKey, reportModels } from "../lib/benchmarkModels";
import { historySegments } from "../ui/PointsHistoryChart";
import type {
  HistorySnapshot,
  ModelHistoryViewPoint,
} from "../hooks/useBenchmarks";
import type { LeaderboardReport, LeaderboardRow } from "../types";
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
  it("counts the cases each point gained or lost since the previous point", () => {
    const missing = snapshot("3", [], 0);
    missing.report.rows[0].points = null;
    const changes = historyMeasurements(
      [
        snapshot("1", ["a"], 500),
        snapshot("2", ["a", "b", "c"], 450),
        missing,
        snapshot("4", ["b", "c", "d"], 400),
      ],
      key,
    ).map((entry) => entry.change);
    // A missing result breaks the line, not the comparison with the last point.
    expect(changes).toEqual([
      null,
      { added: 2, removed: 0 },
      { added: 1, removed: 1 },
    ]);
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

describe("model history view equivalence", () => {
  const model = modelKey(configuration);
  function report(overrides: Partial<LeaderboardRow> = {}): LeaderboardReport {
    const text = leaderboardRow({ points: 100, attemptIds: ["text-cell"] });
    const repository = leaderboardRow({
      configuration: {
        ...configuration,
        id: "repository-config",
        executionProfile: "native_repository",
      },
      points: 200,
      attemptIds: ["repository-cell"],
    });
    const aggregate = leaderboardRow({
      points: 600,
      scored: 2,
      planned: 3,
      complete: 1,
      suitePlanned: 2,
      suiteComplete: 1,
      scoredVersionIds: ["a", "b"],
      missingVersionIds: ["c"],
      attemptIds: ["repository-cell", "text-cell", "refused-cell"],
      resultAttemptIds: ["text-cell", "repository-cell"],
      comparisonKey: "all-peer-baseline-a",
      ownVersionIds: ["authored-case"],
      ...overrides,
    });
    const peer = leaderboardRow({
      configuration: {
        ...configuration,
        id: "peer-config",
        modelId: "peer-model",
      },
      points: 850,
    });
    return {
      cohort: { ...cohort, versionIds: ["c", "a", "b"] },
      rows: [text, repository, peer],
      models: [
        {
          key: model,
          providerId: configuration.providerId,
          modelId: configuration.modelId,
          configurationKeys: [rowKey(text), rowKey(repository)],
          row: aggregate,
        },
        {
          key: modelKey(peer.configuration),
          providerId: peer.configuration.providerId,
          modelId: peer.configuration.modelId,
          configurationKeys: [rowKey(peer)],
          row: peer,
        },
      ],
    };
  }
  function fullPoint(
    id: string,
    recalculatedReport: LeaderboardReport,
  ): HistorySnapshot {
    return {
      id,
      runId: `run-${id}`,
      createdAt: 1_000 + Number(id),
      // Deliberately different scoring/evidence: a view must never use it.
      report: {
        cohort,
        rows: [leaderboardRow({ points: 50, attemptIds: ["dated-only"] })],
      },
      recalculatedReport,
      backfilledVersionIds: [],
      revisedVersionIds: [],
    };
  }
  function project(point: HistorySnapshot): ModelHistoryViewPoint {
    if (!point.id || !point.recalculatedReport)
      throw new Error("invalid invented full point");
    return {
      id: point.id,
      runId: point.runId,
      createdAt: point.createdAt,
      recalculatedReport: point.recalculatedReport,
      backfilledVersionIds: point.backfilledVersionIds ?? [],
      revisedVersionIds: point.revisedVersionIds ?? [],
    };
  }

  it("matches all measurements, gaps and coverage changes after removing only dated reports", () => {
    const first = fullPoint("1", report());
    const duplicate = {
      ...first,
      id: "2",
      runId: "unrelated-run",
      createdAt: 1_002,
    };
    const backfilled = {
      ...first,
      id: "3",
      createdAt: 1_003,
      backfilledVersionIds: ["b"],
    };
    const unscored = fullPoint("4", report({ points: null }));
    const removed = fullPoint("5", { cohort, rows: [] });
    const changed = fullPoint(
      "6",
      report({
        points: 650,
        cost: 0.07,
        scoredVersionIds: ["b", "c"],
        missingVersionIds: ["a"],
        attemptIds: ["new-c", "new-b"],
        comparisonKey: "all-peer-baseline-b",
      }),
    );
    changed.revisedVersionIds = ["b"];
    const full = [first, duplicate, backfilled, unscored, removed, changed];
    const before = structuredClone(full);
    const projected = full.map(project);
    const expected = historyMeasurements(full, model, false, true).map(
      (entry) => ({
        ...entry,
        snapshot: project(entry.snapshot),
      }),
    );
    const actual = modelHistoryMeasurements(projected, model);
    expect(actual).toEqual(expected);
    expect(actual.map((entry) => entry.snapshot.id)).toEqual(["1", "3", "6"]);
    expect(actual.map((entry) => entry.change)).toEqual([
      null,
      { added: 0, removed: 0 },
      { added: 1, removed: 1 },
    ]);
    expect(actual[2].series).not.toBe(actual[0].series);
    expect(actual[2].snapshot.revisedVersionIds).toEqual(["b"]);
    expect(full).toEqual(before);
    expect(
      historyMeasurements(full, model, true, true)[0].row.attemptIds,
    ).toEqual(["dated-only"]);
  });

  it("retains all peer standings, configuration evidence, cohort order and suite counters", () => {
    const full = fullPoint("1", report());
    const projected = project(full);
    const actual = modelHistoryMeasurements([projected], model)[0];
    const expected = historyMeasurements([full], model, false, true)[0];
    expect(actual.report).toBe(projected.recalculatedReport);
    expect(actual.report).toEqual(expected.report);
    expect(actual.row.points).toBe(600); // Neither individual configuration's score.
    expect(actual.row.attemptIds).toEqual([
      "repository-cell",
      "text-cell",
      "refused-cell",
    ]);
    expect(actual.row.resultAttemptIds).toEqual([
      "text-cell",
      "repository-cell",
    ]);
    expect(actual.report.cohort?.versionIds).toEqual(["c", "a", "b"]);
    expect(actual.row).toMatchObject({
      complete: 1,
      planned: 3,
      suiteComplete: 1,
      suitePlanned: 2,
    });
    expect(reportModels(actual.report)[0].configurations).toHaveLength(2);
    const standings = (value: LeaderboardReport) =>
      boardsFor(value.cohort).map((board) =>
        rankRows(
          reportModels(value).map((entry) => entry.row),
          board,
        ),
      );
    expect(standings(actual.report)).toEqual(standings(expected.report));
    expect(
      standings(actual.report)[0].find((entry) => entry.row === actual.row)
        ?.rank,
    ).toBe(2);
  });

  it("preserves legacy row aggregation and runtime fallback when native model rows are absent", () => {
    const first = fullPoint("1", {
      cohort,
      rows: [leaderboardRow({ points: 500 })],
    });
    const next = fullPoint("2", {
      cohort,
      rows: [
        leaderboardRow({
          points: 700,
          configuration: { ...configuration, inventoryRevision: "runtime-2" },
        }),
      ],
    });
    const actual = modelHistoryMeasurements(
      [project(first), project(next)],
      model,
    );
    expect(actual).toEqual(
      historyMeasurements([first, next], model, false, true).map((entry) => ({
        ...entry,
        snapshot: project(entry.snapshot),
      })),
    );
    expect(actual[0].series).not.toBe(actual[1].series);
    const legacy = { runId: "legacy", createdAt: 1, report: first.report };
    expect(
      historyMeasurements([legacy], model, false, true)[0].row.points,
    ).toBe(50);
  });
});
