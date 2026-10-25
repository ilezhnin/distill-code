import { describe, expect, it } from "vitest";
import {
  automaticExecutorOptions,
  applicationExecutorPriorIds,
  applicationExecutorConfiguration,
  applicationExecutorEffortOptions,
  type ApplicationExecutorOption,
} from "./applicationExecutor";

const preferred: ApplicationExecutorOption = {
  target: {
    harnessId: "example-acp",
    modelProviderId: "example-acp",
    modelId: "example-model",
    modelName: "Example model",
  },
  runSettings: { effort: "high", fast: false },
};

describe("application executor choices", () => {
  it("keeps executable identity separate from unknown runtime provenance", () => {
    expect(applicationExecutorConfiguration(preferred)).toMatchObject({
      providerId: "example-acp",
      modelId: "example-model",
      effort: "high",
      fastMode: false,
      accountId: null,
      inventoryRevision: null,
      billingMode: "unknown",
      executionProfile: "interactive_acp",
    });
  });

  it("adds advertised effort variants after unchanged preferences without inventing fast mode", () => {
    const options = applicationExecutorEffortOptions([preferred], () => ({
      id: "example-model",
      efforts: [{ id: "low" }, { id: "high" }, { id: "low" }],
    }));
    expect(options[0]).toBe(preferred);
    expect(options.map((option) => option.runSettings)).toEqual([
      { effort: "high", fast: false },
      { effort: "low", fast: false },
    ]);
    expect(new Set(options.map((option) => option.target))).toEqual(
      new Set([preferred.target]),
    );
  });

  it("treats the CLI's default as the unspecified effort, not a level of its own", () => {
    const unspecified = { target: preferred.target };
    const cliDefault = { ...unspecified, runSettings: { effort: "default" } };
    expect(applicationExecutorConfiguration(cliDefault)).toEqual(
      applicationExecutorConfiguration(unspecified),
    );
    const options = applicationExecutorEffortOptions([unspecified], () => ({
      id: "example-model",
      efforts: [{ id: "default" }, { id: "high" }],
      supportsFast: false,
    }));
    expect(options.map((option) => option.runSettings)).toEqual([
      undefined,
      { fast: false },
      { effort: "high" },
      { effort: "high", fast: false },
    ]);
  });

  it("does not invent capabilities or use another provider's menu", () => {
    for (const model of [
      undefined,
      { id: "example-model" },
      { id: "example-model", efforts: [] },
      {
        id: "example-model",
        providerId: "other-provider",
        efforts: [{ id: "low" }],
      },
    ]) {
      expect(
        applicationExecutorEffortOptions([preferred], () => model),
      ).toEqual([preferred]);
    }
  });

  it("keeps unspecified fast distinct from an explicit advertised normal-mode choice", () => {
    const unspecified = { ...preferred, runSettings: { effort: "high" } };
    const options = applicationExecutorEffortOptions([unspecified], () => ({
      id: "example-model",
      efforts: [{ id: "high" }, { id: "low" }],
      supportsFast: true,
    }));
    expect(options.map((option) => option.runSettings)).toEqual([
      { effort: "high" },
      { effort: "high", fast: false },
      { effort: "high", fast: true },
      { effort: "low" },
      { effort: "low", fast: false },
      { effort: "low", fast: true },
    ]);
    expect(
      new Set(
        options.map((option) => applicationExecutorConfiguration(option)?.id),
      ).size,
    ).toBe(6);
    expect(applicationExecutorConfiguration(options[0])?.fastMode).toBeNull();
    expect(applicationExecutorConfiguration(options[1])?.fastMode).toBe(false);
  });

  it("keeps all ordinary candidates with preferences first", () => {
    const options = applicationExecutorEffortOptions([preferred], () => ({
      id: "example-model",
      efforts: Array.from({ length: 40 }, (_, index) => ({
        id: `effort-${index}`,
      })),
    }));
    expect(options).toHaveLength(41);
    expect(options[0]).toBe(preferred);
  });
});

it("does not turn a saved preference into an automatic candidate whitelist", () => {
  const preferred = {
    target: {
      harnessId: "codex-acp",
      modelProviderId: "codex-acp",
      modelId: "fictional-prior",
      modelName: "Fictional prior",
    },
    runSettings: { effort: "high" },
  };
  const options = automaticExecutorOptions(
    {
      providers: [{ id: "codex-acp" }, { id: "claude-acp" }],
      getModelsForHarness: (id) =>
        id === "codex-acp"
          ? [{ id: "fictional-prior", efforts: [{ id: "high" }] }]
          : [
              {
                id: "fictional-learned",
                efforts: [{ id: "low" }, { id: "high" }],
                supportsFast: false,
              },
            ],
      rateLimits: [],
    },
    [preferred],
  );
  expect(options[0]).toBe(preferred);
  expect(options).toContainEqual({
    target: {
      harnessId: "claude-acp",
      modelProviderId: "claude-acp",
      modelId: "fictional-learned",
      modelName: "fictional-learned",
    },
    runSettings: { effort: "low", fast: false },
  });
});

it("keeps unranked advertised configurations beyond position 32", () => {
  const options = automaticExecutorOptions(
    {
      providers: [{ id: "codex-acp" }],
      getModelsForHarness: () =>
        Array.from({ length: 40 }, (_, index) => ({
          id: `fictional-${index}`,
          efforts: [{ id: "low" }],
        })),
      rateLimits: [],
    },
    [],
  );
  expect(
    options.some(
      (option) =>
        option.target.modelId === "fictional-39" &&
        option.runSettings?.effort === "low",
    ),
  ).toBe(true);
  expect(
    new Set(
      options.map((option) => applicationExecutorConfiguration(option)?.id),
    ).size,
  ).toBe(options.length);
});

it("excludes exhausted platforms even when a saved preference names them", () => {
  const pinnedFallback = {
    target: {
      harnessId: "codex-acp",
      modelProviderId: "codex-acp",
      modelId: "fictional-model",
      modelName: "Fictional model",
    },
  };
  const options = automaticExecutorOptions(
    {
      providers: [{ id: "codex-acp" }],
      getModelsForHarness: () => [{ id: "fictional-model" }],
      rateLimits: [
        {
          provider: "codex-acp",
          accountLimited: true,
          session: null,
          weekly: null,
          updatedAt: 0,
          error: null,
          status: "ok",
          configured: true,
        },
      ],
    },
    [pinnedFallback],
  );
  expect(options).toEqual([]);
});

it("deduplicates saved fallback IDs and uses an available default only when none survives", () => {
  const first = applicationExecutorConfiguration(preferred);
  if (!first) throw new Error("The fixture must identify a concrete model");
  const second = { ...first, id: "second" };
  const rows = [
    { configuration: first, available: true },
    { configuration: second, available: true },
  ];
  expect(
    applicationExecutorPriorIds(rows, ["second", "second", first.id]),
  ).toEqual(["second", first.id]);
  expect(applicationExecutorPriorIds(rows, ["missing"])).toEqual([first.id]);
  expect(
    applicationExecutorPriorIds(
      rows.map((row) => ({ ...row, available: false })),
      [first.id],
    ),
  ).toEqual([]);
});
