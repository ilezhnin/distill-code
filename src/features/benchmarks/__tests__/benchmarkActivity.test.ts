import { describe, expect, it } from "vitest";
import {
  activeRuns,
  rowActivity,
  runProgress,
  runningConfigurations,
  stalledRuns,
} from "../lib/benchmarkActivity";
import type { RunSummary } from "../types";
import { configuration, leaderboardRow, runSummary } from "./fixtures";

const other = { ...configuration, id: "config-2", modelId: "model-2" };

function summary(overrides: Partial<RunSummary>): RunSummary {
  return {
    ...runSummary,
    state: "running",
    request: {
      ...runSummary.request,
      versionIds: ["version-1", "version-2"],
      configurations: [configuration, other],
    },
    attemptCount: 4,
    settledCount: 1,
    openCells: [
      { configurationId: "config-1", versionId: "version-2", running: true },
      { configurationId: "config-2", versionId: "version-1", running: true },
      { configurationId: "config-2", versionId: "version-2" },
    ],
    ...overrides,
  };
}

describe("benchmark activity", () => {
  it("tells runs that dispatch from runs that wait, never previews", () => {
    const runs = [
      summary({ id: "running" }),
      summary({ id: "attention", state: "needs_attention" }),
      summary({ id: "paused", state: "paused" }),
      summary({ id: "done", state: "completed" }),
      summary({
        id: "preview",
        request: { ...summary({}).request, preview: true },
      }),
    ];
    expect(activeRuns(runs).map((run) => run.id)).toEqual(["running"]);
    expect(stalledRuns(runs).map((run) => run.id)).toEqual(["attention"]);
  });

  it("sums attempts and names the models running now", () => {
    const run = summary({});
    expect(runProgress([run, run])).toEqual({
      settled: 2,
      total: 8,
      running: 4,
    });
    expect(runningConfigurations(run).map((entry) => entry.id)).toEqual([
      "config-1",
      "config-2",
    ]);
  });

  it("counts a row's open and running cells and points at its newest run", () => {
    const row = leaderboardRow({ configuration: other });
    const older = summary({ id: "older", createdAt: 1 });
    const newer = summary({ id: "newer", createdAt: 2 });
    expect(rowActivity(row, [older, newer])).toEqual({
      open: 4,
      running: 2,
      runId: "newer",
    });
    expect(rowActivity(row, [summary({ state: "completed" })])).toEqual({
      open: 0,
      running: 0,
      runId: null,
    });
  });
});
