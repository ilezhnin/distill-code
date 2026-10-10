import { describe, expect, it } from "vitest";
import { rowKey } from "../lib/benchmarkBoards";
import {
  leaderboardModels,
  modelActivity,
  modelKey,
  reportModels,
} from "../lib/benchmarkModels";
import { configuration, leaderboardRow, runSummary } from "./fixtures";

describe("leaderboard model identities", () => {
  it("keeps profiles, effort, fast mode, billing, accounts and runtimes under one model", () => {
    const measured = leaderboardRow({ scored: 8, complete: 8, points: 600 });
    const rows = [
      measured,
      ...[
        { executionProfile: "protected_repository" },
        { effort: "max" },
        { fastMode: true },
        { billingMode: "api" },
        { accountId: "second-account", inventoryRevision: "new-runtime" },
      ].map((settings) =>
        leaderboardRow({
          configuration: { ...configuration, ...settings },
          scored: 0,
          complete: 0,
          points: null,
          measuredAt: 9000,
        }),
      ),
    ];
    const [model] = leaderboardModels(rows);
    expect(leaderboardModels(rows)).toHaveLength(1);
    expect(model.configurations).toHaveLength(6);
    expect(model.row).toBe(measured);
    expect(new Set(rows.map((row) => modelKey(row.configuration))).size).toBe(
      1,
    );
    expect(rows[0].scored).toBe(8);
  });

  it("chooses coverage then recency, never the highest score", () => {
    const old = leaderboardRow({ scored: 8, measuredAt: 1, points: 1000 });
    const recent = leaderboardRow({
      configuration: { ...configuration, effort: "max" },
      scored: 8,
      measuredAt: 2,
      points: 200,
    });
    const narrow = leaderboardRow({
      configuration: { ...configuration, effort: "low" },
      scored: 2,
      measuredAt: 3,
      points: 1000,
    });
    expect(leaderboardModels([narrow, old, recent])[0].row).toBe(recent);
  });

  it("preserves distinct providers, model ids and versions behind moving aliases", () => {
    const rows = [
      leaderboardRow(),
      leaderboardRow({
        configuration: { ...configuration, modelId: "other-model" },
      }),
      ...["K2.7", "K2.8"].map((modelName) =>
        leaderboardRow({
          configuration: {
            ...configuration,
            providerId: "kimi-acp",
            modelId: "kimi-code/kimi-for-coding",
            modelName,
          },
        }),
      ),
    ];
    expect(leaderboardModels(rows)).toHaveLength(4);
  });

  it("uses the native model score instead of a configuration score", () => {
    const text = leaderboardRow();
    const repository = leaderboardRow({
      configuration: {
        ...configuration,
        executionProfile: "protected_repository",
      },
    });
    const combined = leaderboardRow({
      points: 550,
      attemptIds: ["text", "repository"],
    });
    const models = reportModels({
      cohort: null,
      rows: [text, repository],
      models: [
        {
          key: modelKey(configuration),
          providerId: configuration.providerId,
          modelId: configuration.modelId,
          configurationKeys: [rowKey(text), rowKey(repository)],
          row: combined,
        },
      ],
    });
    expect(models).toHaveLength(1);
    expect(models[0].row).toBe(combined);
    expect(models[0].configurations).toEqual([text, repository]);
  });

  it("shows activity from a different configuration on the same model", () => {
    const repository = {
      ...configuration,
      id: "repository",
      executionProfile: "protected_repository",
    };
    const [model] = leaderboardModels([
      leaderboardRow({ scored: 8 }),
      leaderboardRow({ configuration: repository, scored: 0 }),
    ]);
    const active = {
      ...runSummary,
      state: "running",
      request: { ...runSummary.request, configurations: [repository] },
      openCells: [
        {
          configurationId: repository.id,
          versionId: "version-1",
          running: true,
        },
      ],
    };
    expect(modelActivity(model, [active])).toMatchObject({
      open: 1,
      running: 1,
    });
  });
});
