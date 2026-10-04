import { describe, expect, it } from "vitest";
import {
  catchUpCases,
  resolveCatchUpConfiguration,
} from "../lib/benchmarkCatchUp";
import type { Configuration, InventoryModel, RunSummary } from "../types";
import { configuration, leaderboardRow, runSummary } from "./fixtures";

const current: InventoryModel = {
  configuration: {
    ...configuration,
    id: "claude-acp:account-1:model-1",
    effort: null,
    fastMode: null,
    inventoryRevision: "runtime-now",
  },
  name: "Model one",
  efforts: ["low", "high"],
  supportsFastMode: true,
  available: true,
  reason: null,
};

function pinned(row: Configuration, inventory = [current]) {
  const resolution = resolveCatchUpConfiguration(row, inventory);
  if (!("configuration" in resolution))
    throw new Error(`unexpected ${resolution.issue}`);
  return resolution.configuration;
}

describe("catch-up configuration", () => {
  it("pins today's runtime instead of the newest attempt's", () => {
    const row = { ...configuration, inventoryRevision: "runtime-then" };
    expect(pinned(row)).toEqual({
      ...configuration,
      id: "claude-acp:account-1:model-1:high:false",
      inventoryRevision: "runtime-now",
    });
  });

  it("requests the native profile when the row carries an evidence label", () => {
    const row = {
      ...configuration,
      executionProfile: "native_text_auxiliary",
    };
    expect(pinned(row).executionProfile).toBe("native_text");
  });

  it("keeps the row's own level and never runs a model with levels unset", () => {
    expect(pinned({ ...configuration, effort: "low" }).effort).toBe("low");
    // "default" names no level, so a row measured at it cannot run again,
    // even on a runtime that still lists it.
    const measuredAtDefault = { ...configuration, effort: "default" };
    expect(resolveCatchUpConfiguration(measuredAtDefault, [current])).toEqual({
      issue: "changed",
    });
    expect(
      resolveCatchUpConfiguration(measuredAtDefault, [
        { ...current, efforts: ["default", "high"] },
      ]),
    ).toEqual({ issue: "changed" });
    // Unset only for a model without an effort control.
    const unset = { ...configuration, effort: null, fastMode: null };
    expect(resolveCatchUpConfiguration(unset, [current])).toEqual({
      issue: "changed",
    });
    expect(pinned(unset, [{ ...current, efforts: [] }])).toMatchObject({
      effort: null,
      fastMode: null,
    });
  });

  it("refuses a model or option the runtime no longer offers", () => {
    const row = { ...configuration, inventoryRevision: "runtime-then" };
    expect(resolveCatchUpConfiguration(row, [])).toEqual({ issue: "missing" });
    // A listed model the runtime blocks carries the inventory's own reason.
    expect(
      resolveCatchUpConfiguration(row, [
        { ...current, available: false, reason: "Not verified" },
      ]),
    ).toEqual({ issue: "unavailable", reason: "Not verified" });
    expect(
      resolveCatchUpConfiguration(row, [
        { ...current, available: false, reason: null },
      ]),
    ).toEqual({ issue: "unavailable", reason: null });
    expect(
      resolveCatchUpConfiguration(row, [{ ...current, efforts: ["low"] }]),
    ).toEqual({ issue: "changed" });
    expect(
      resolveCatchUpConfiguration({ ...row, fastMode: true }, [
        { ...current, supportsFastMode: false },
      ]),
    ).toEqual({ issue: "changed" });
    expect(
      resolveCatchUpConfiguration(row, [
        {
          ...current,
          configuration: { ...current.configuration, billingMode: "api" },
        },
      ]),
    ).toEqual({ issue: "changed" });
  });

  it("never fills a moving alias's row with the model it points at now", () => {
    const k27 = {
      ...configuration,
      providerId: "kimi-acp",
      accountId: "cli-login-kimi-acp",
      modelId: "kimi-code/kimi-for-coding",
      modelName: "K2.7 Code",
    };
    const listed = (modelName: string): InventoryModel => ({
      ...current,
      configuration: {
        ...k27,
        effort: null,
        fastMode: null,
        inventoryRevision: "runtime-now",
        modelName,
      },
    });
    expect(resolveCatchUpConfiguration(k27, [listed("K2.8 Preview")])).toEqual({
      issue: "missing",
    });
    expect(pinned(k27, [listed("K2.7 Code")]).inventoryRevision).toBe(
      "runtime-now",
    );
    // Any other id keeps its row under a new display name.
    expect(
      pinned({ ...configuration, modelName: "Model one" }, [
        {
          ...current,
          configuration: { ...current.configuration, modelName: "Model 1.1" },
        },
      ]).modelName,
    ).toBe("Model 1.1");
  });
});

describe("catch-up cases", () => {
  const row = leaderboardRow({
    missingVersionIds: ["version-1", "version-2", "version-3"],
  });
  const active = (
    overrides: Partial<RunSummary>,
    request: Partial<RunSummary["request"]> = {},
  ): RunSummary => ({
    ...runSummary,
    state: "running",
    ...overrides,
    request: {
      ...runSummary.request,
      versionIds: ["version-1"],
      configurations: [{ ...configuration, effort: null, fastMode: null }],
      ...request,
    },
  });

  it("leaves out gaps an unfinished run already plans for this model", () => {
    const result = catchUpCases(row, [
      active({ id: "older-run", createdAt: 10, state: "paused" }),
      active({ id: "newer-run", createdAt: 20 }, { versionIds: ["version-2"] }),
    ]);
    expect(result).toEqual({ owed: ["version-3"], queuedRunId: "newer-run" });
  });

  it("offers a gap the unfinished run already settled without a score", () => {
    // version-1 settled as an infrastructure failure; only version-2 is open.
    const campaign = active(
      {
        id: "campaign",
        openCells: [
          { configurationId: "config-1", versionId: "version-2" },
          { configurationId: "config-2", versionId: "version-1" },
        ],
      },
      {
        versionIds: ["version-1", "version-2"],
        configurations: [
          { ...configuration, effort: null, fastMode: null },
          { ...configuration, id: "config-2", modelId: "model-2" },
        ],
      },
    );
    expect(catchUpCases(row, [campaign])).toEqual({
      owed: ["version-1", "version-3"],
      queuedRunId: "campaign",
    });
    // A parked run with nothing left open plans no gap at all.
    const parked = active(
      { id: "parked", state: "needs_attention", openCells: [] },
      { versionIds: ["version-1", "version-2", "version-3"] },
    );
    expect(catchUpCases(row, [parked])).toEqual({
      owed: ["version-1", "version-2", "version-3"],
      queuedRunId: null,
    });
  });

  it("offers every gap when no unfinished run plans it", () => {
    const result = catchUpCases(row, [
      active({ id: "done", state: "completed" }),
      active({ id: "stopping", state: "cancelling" }),
      active({ id: "preview" }, { preview: true }),
      active(
        { id: "other-model" },
        {
          configurations: [{ ...configuration, modelId: "model-2" }],
        },
      ),
      active(
        { id: "other-effort" },
        { configurations: [{ ...configuration, effort: "low" }] },
      ),
    ]);
    expect(result).toEqual({
      owed: ["version-1", "version-2", "version-3"],
      queuedRunId: null,
    });
  });

  it("matches a request left to the provider by what its attempts ran with", () => {
    // The run asked for no effort; its attempts acknowledged the default.
    const campaign = active(
      {
        id: "campaign",
        observedSelections: [
          { configurationId: "config-1", effort: "default", fastMode: false },
        ],
      },
      { versionIds: ["version-1", "version-2", "version-3"] },
    );
    const at = (effort: string | null) =>
      catchUpCases(
        leaderboardRow({
          configuration: { ...configuration, effort },
          missingVersionIds: ["version-1", "version-2", "version-3"],
        }),
        [campaign],
      );
    // A row measured at an explicit effort never receives those attempts.
    expect(at("low")).toEqual({
      owed: ["version-1", "version-2", "version-3"],
      queuedRunId: null,
    });
    for (const effort of [null, "default"])
      expect(at(effort)).toEqual({ owed: [], queuedRunId: "campaign" });
    // A provider default acknowledged as an explicit level fills that row.
    campaign.observedSelections = [
      { configurationId: "config-1", effort: "high", fastMode: false },
    ];
    expect(at("high")).toEqual({ owed: [], queuedRunId: "campaign" });
    expect(at("low").queuedRunId).toBeNull();
  });
});
