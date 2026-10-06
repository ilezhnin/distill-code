import { describe, expect, it } from "vitest";
import {
  boardShares,
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
    speedShare: 0.2,
    costShare: 0.1,
    axes: [
      {
        id: "algorithms",
        quality: 0.5,
        points: 500,
        speedShare: 0.6,
        costShare: null,
        passed: 1,
        scored: 2,
        planned: 2,
      },
    ],
  }),
  leaderboardRow({
    configuration: { ...configuration, id: "b", modelId: "beta" },
    points: 500,
    axes: [
      {
        id: "algorithms",
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
    speedShare: 0.067,
    costShare: 0.033,
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

  it("keeps one row per model whichever account a run went on", () => {
    expect(
      configurationKey({ ...configuration, accountId: "another-account" }),
    ).toBe(configurationKey(configuration));
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

  it("keeps one row per display name of a model id its vendor moves", () => {
    const kimi = {
      ...configuration,
      providerId: "kimi-acp",
      accountId: "cli-login-kimi-acp",
      modelId: "kimi-code/kimi-for-coding",
      modelName: "K2.7 Code",
    };
    const moved = { ...kimi, modelName: "K2.8 Preview" };
    expect(configurationKey(moved)).not.toBe(configurationKey(kimi));
    // The same key the service builds (analysis::leaderboard_key).
    expect(configurationKey({ ...moved, effort: null })).toBe(
      JSON.stringify([
        [
          "kimi-acp",
          "kimi-code/kimi-for-coding",
          "default",
          false,
          "subscription",
          "native_text",
        ],
        "K2.8 Preview",
      ]),
    );
    // Every other id keeps one row whatever its display name.
    const k3 = { ...kimi, modelId: "kimi-code/k3", modelName: "K3" };
    expect(configurationKey({ ...k3, modelName: "K3 Turbo" })).toBe(
      configurationKey(k3),
    );
    const sonnet = { ...configuration, modelId: "sonnet", modelName: "Sonnet" };
    expect(configurationKey({ ...sonnet, modelName: null })).toBe(
      configurationKey(sonnet),
    );
  });

  it("builds the overall board plus one per work class", () => {
    expect(boardsFor(cohort).map((board) => board.id)).toEqual([
      "overall",
      "class:algorithms",
    ]);
    expect(boardsFor(null).map((board) => board.id)).toEqual(["overall"]);
  });

  it("reads what went into a board's points from the row or its class axis", () => {
    const [overall, coding] = boardsFor(cohort);
    expect(boardShares(rows[0], overall)).toEqual({
      passed: 1,
      scored: 1,
      speed: 0.2,
      cost: 0.1,
    });
    expect(boardShares(rows[0], coding)).toEqual({
      passed: 1,
      scored: 2,
      speed: 0.6,
      cost: null,
    });
    // A row never measured on the class has nothing to show there.
    expect(boardShares(rows[2], coding)).toEqual({
      passed: 0,
      scored: 0,
      speed: null,
      cost: null,
    });
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

  it("orders a class board by its own points and leaves missing ones unranked", () => {
    const boards = boardsFor(cohort);
    const workClass = rankRows(rows, boards[1]);
    expect(workClass.map((entry) => entry.row.configuration.modelId)).toEqual([
      "beta",
      "alpha",
      "gamma",
      "delta",
    ]);
    expect(workClass[0].share).toBe(100);
    expect(workClass[1].share).toBe(50);
    // A row without a measurement on the class cannot rank, even when it is
    // comparable.
    expect(
      workClass.find((entry) => entry.row.configuration.modelId === "gamma")
        ?.rank,
    ).toBeNull();
  });
});
