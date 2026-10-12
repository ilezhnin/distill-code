import { describe, expect, it } from "vitest";
import {
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
      { effort: "low" },
      { effort: "low", fast: false },
    ]);
    expect(
      new Set(
        options.map((option) => applicationExecutorConfiguration(option)?.id),
      ).size,
    ).toBe(4);
    expect(applicationExecutorConfiguration(options[0])?.fastMode).toBeNull();
    expect(applicationExecutorConfiguration(options[1])?.fastMode).toBe(false);
  });

  it("keeps the native 32-candidate bound with all preferences first", () => {
    const options = applicationExecutorEffortOptions([preferred], () => ({
      id: "example-model",
      efforts: Array.from({ length: 40 }, (_, index) => ({
        id: `effort-${index}`,
      })),
    }));
    expect(options).toHaveLength(32);
    expect(options[0]).toBe(preferred);
  });
});
