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
  it("keeps profiles, billing, accounts and runtimes under one model", () => {
    const measured = leaderboardRow({ scored: 8, complete: 8, points: 600 });
    const rows = [
      measured,
      ...[
        { executionProfile: "protected_repository" },
        { billingMode: "api" },
        { accountId: "second-account", inventoryRevision: "new-runtime" },
        // An omitted fast mode is off.
        { fastMode: null },
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
    expect(model.configurations).toHaveLength(5);
    expect(model.row).toBe(measured);
    expect(new Set(rows.map((row) => modelKey(row.configuration))).size).toBe(
      1,
    );
    expect(rows[0].scored).toBe(8);
  });

  it("gives every effort and fast mode its own row", () => {
    const rows = [
      leaderboardRow(),
      leaderboardRow({ configuration: { ...configuration, effort: "max" } }),
      leaderboardRow({ configuration: { ...configuration, fastMode: true } }),
      leaderboardRow({
        configuration: { ...configuration, effort: "max", fastMode: true },
      }),
    ];
    const models = leaderboardModels(rows);
    expect(models).toHaveLength(4);
    expect(models.map((model) => model.configurations)).toEqual(
      rows.map((row) => [row]),
    );
    // An omitted effort is the default, as in the service's model key.
    expect(modelKey({ ...configuration, effort: null })).toBe(
      modelKey({ ...configuration, effort: "default" }),
    );
    expect(modelKey({ ...configuration, effort: null })).toBe(
      '["claude-acp","model-1","default",false]',
    );
  });

  it("chooses coverage then recency, never the highest score", () => {
    const old = leaderboardRow({ scored: 8, measuredAt: 1, points: 1000 });
    const recent = leaderboardRow({
      configuration: { ...configuration, billingMode: "api" },
      scored: 8,
      measuredAt: 2,
      points: 200,
    });
    const narrow = leaderboardRow({
      configuration: {
        ...configuration,
        executionProfile: "protected_repository",
      },
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

  it("warns only for the model's open cells in the current pool", () => {
    const [model] = leaderboardModels([leaderboardRow()]);
    const other = { ...configuration, id: "other", modelId: "other-model" };
    const stopped = {
      ...runSummary,
      state: "needs_attention",
      request: {
        ...runSummary.request,
        configurations: [configuration, other],
        versionIds: ["retired", "current"],
      },
      openCells: [
        {
          configurationId: configuration.id,
          versionId: "retired",
          running: false,
        },
        { configurationId: other.id, versionId: "current", running: false },
      ],
    };
    expect(modelActivity(model, [stopped], ["current"]).attention).toEqual([]);
    expect(modelActivity(model, [stopped], ["retired"]).attention).toEqual([
      stopped,
    ]);
    const currentFailure = {
      ...stopped,
      openCells: [
        {
          configurationId: configuration.id,
          versionId: "current",
          running: false,
        },
      ],
    };
    expect(
      modelActivity(model, [currentFailure], ["current"]).attention,
    ).toEqual([currentFailure]);
    expect(stopped.state).toBe("needs_attention");
    expect(stopped.openCells).toHaveLength(2);
  });

  it("keeps terminal pending reviews and legacy warnings until measured", () => {
    const [model] = leaderboardModels([leaderboardRow()]);
    const legacy = {
      ...runSummary,
      state: "needs_attention",
      request: { ...runSummary.request, versionIds: ["retired"] },
      openCells: undefined,
    };
    expect(modelActivity(model, [legacy]).attention).toEqual([legacy]);
    expect(modelActivity(model, [legacy], ["current"]).attention).toEqual([]);
    expect(
      modelActivity(model, [{ ...legacy, openCells: [] }]).attention,
    ).toHaveLength(1);
    const [measured] = leaderboardModels([
      leaderboardRow({ completeVersionIds: ["retired"] }),
    ]);
    expect(modelActivity(measured, [legacy]).attention).toEqual([]);
    expect(
      modelActivity(measured, [{ ...legacy, openCells: [] }]).attention,
    ).toEqual([]);
  });
});
