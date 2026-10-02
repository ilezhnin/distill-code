import { describe, expect, it } from "vitest";
import { boardsFor, rankRows, shareOfBest } from "../lib/benchmarkBoards";
import { cohort, configuration, leaderboardRow } from "./fixtures";

const rows = [
  leaderboardRow({
    configuration: { ...configuration, id: "a", modelId: "alpha" },
    quality: 1,
    medianDurationMs: 10_000,
    medianOutputTokens: 500,
    cost: 1,
    axes: [
      { id: "coding-simple", quality: 0.5, passed: 1, scored: 2, planned: 2 },
    ],
  }),
  leaderboardRow({
    configuration: { ...configuration, id: "b", modelId: "beta" },
    quality: 0.5,
    medianDurationMs: 2_000,
    medianOutputTokens: 100,
    cost: 0.1,
    axes: [
      { id: "coding-simple", quality: 1, passed: 2, scored: 2, planned: 2 },
    ],
  }),
  leaderboardRow({
    configuration: { ...configuration, id: "c", modelId: "gamma" },
    quality: 1,
    medianDurationMs: 30_000,
    medianOutputTokens: null,
    cost: 3,
  }),
  leaderboardRow({
    configuration: { ...configuration, id: "d", modelId: "delta" },
    quality: 0.9,
    status: "preliminary",
    scored: 1,
    planned: 4,
  }),
];

describe("leaderboard boards", () => {
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
    // The unranked row still shows how far it is from the leader.
    expect(ranked[3].share).toBe(90);
  });

  it("ranks lower-is-better boards ascending and fills the leader's bar", () => {
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

  it("clamps shares and treats a zero best honestly", () => {
    expect(shareOfBest(2, 1, true)).toBe(100);
    expect(shareOfBest(0.5, 1, true)).toBe(50);
    expect(shareOfBest(1, 0, true)).toBe(0);
    expect(shareOfBest(0, 1, false)).toBe(100);
    expect(shareOfBest(4, 1, false)).toBe(25);
  });
});
