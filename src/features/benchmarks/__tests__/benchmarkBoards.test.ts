import { describe, expect, it } from "vitest";
import {
  boardsFor,
  configurationKey,
  rankRows,
  rowKey,
} from "../lib/benchmarkBoards";
import { cohort, configuration, leaderboardRow } from "./fixtures";

const rows = [
  leaderboardRow({
    configuration: { ...configuration, id: "a", modelId: "alpha" },
    points: 1000,
    speedPoints: 200,
    efficiencyPoints: 200,
    costPoints: 100,
    axes: [
      {
        id: "coding-simple",
        quality: 0.5,
        points: 500,
        passed: 1,
        scored: 2,
        planned: 2,
      },
    ],
  }),
  leaderboardRow({
    configuration: { ...configuration, id: "b", modelId: "beta" },
    points: 500,
    speedPoints: 1000,
    efficiencyPoints: 1000,
    costPoints: 1000,
    axes: [
      {
        id: "coding-simple",
        quality: 1,
        points: 1000,
        passed: 2,
        scored: 2,
        planned: 2,
      },
    ],
  }),
  leaderboardRow({
    configuration: { ...configuration, id: "c", modelId: "gamma" },
    points: 1000,
    speedPoints: 67,
    efficiencyPoints: null,
    costPoints: 33,
  }),
  leaderboardRow({
    configuration: { ...configuration, id: "d", modelId: "delta" },
    points: 900,
    status: "preliminary",
    scored: 1,
    planned: 4,
  }),
];

describe("leaderboard boards", () => {
  it("keeps model navigation stable across runtime updates and implicit defaults", () => {
    const before = leaderboardRow({
      configuration: { ...configuration, effort: null, fastMode: null },
    });
    const after = leaderboardRow({
      configuration: {
        ...configuration,
        id: "new-probe",
        effort: "default",
        fastMode: false,
        inventoryRevision: "new-runtime",
        modelName: "New display name",
      },
    });
    expect(rowKey(after)).toBe(rowKey(before));
    expect(
      rowKey(
        leaderboardRow({
          configuration: { ...after.configuration, effort: "high" },
        }),
      ),
    ).not.toBe(rowKey(before));
    expect(
      rowKey(
        leaderboardRow({
          configuration: { ...after.configuration, fastMode: true },
        }),
      ),
    ).not.toBe(rowKey(before));
  });

  it("keeps an attempt with auxiliary calls on its configuration's row", () => {
    const row = leaderboardRow({ configuration });
    const auxiliary = {
      ...configuration,
      executionProfile: "native_text_auxiliary",
    };
    expect(configurationKey(auxiliary)).toBe(rowKey(row));
    expect(
      configurationKey({ ...configuration, executionProfile: "isolated_ui" }),
    ).not.toBe(rowKey(row));
  });

  it("builds one board per shared measurement plus one per work class", () => {
    expect(boardsFor(cohort).map((board) => board.id)).toEqual([
      "overall",
      "class:coding-simple",
      "efficiency",
      "speed",
      "cost",
    ]);
    expect(boardsFor(null).map((board) => board.id)).toEqual([
      "overall",
      "efficiency",
      "speed",
      "cost",
    ]);
  });

  it("shares ranks between ties and skips the next rank", () => {
    const [overall] = boardsFor(cohort);
    const ranked = rankRows(rows, overall);
    expect(
      ranked.map((entry) => [entry.row.configuration.modelId, entry.rank]),
    ).toEqual([
      ["alpha", 1],
      ["gamma", 1],
      ["beta", 3],
      ["delta", null],
    ]);
    // The unranked row keeps its points and bar, just no place.
    expect(ranked[3].points).toBe(900);
    expect(ranked[3].share).toBe(90);
  });

  it("orders every board by its own points and leaves missing ones unranked", () => {
    const boards = boardsFor(cohort);
    const speed = rankRows(rows, boards[3]);
    expect(speed.map((entry) => entry.row.configuration.modelId)).toEqual([
      "beta",
      "alpha",
      "gamma",
      "delta",
    ]);
    expect(speed[0].share).toBe(100);
    expect(speed[1].share).toBe(20);
    const efficiency = rankRows(rows, boards[2]);
    // A row without a measurement cannot rank, even when it is comparable.
    expect(
      efficiency.find((entry) => entry.row.configuration.modelId === "gamma")
        ?.rank,
    ).toBeNull();
    const workClass = rankRows(rows, boards[1]);
    expect(
      workClass.slice(0, 2).map((entry) => entry.row.configuration.modelId),
    ).toEqual(["beta", "alpha"]);
  });
});
