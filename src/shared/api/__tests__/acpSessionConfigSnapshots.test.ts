import { describe, expect, it } from "vitest";

import {
  readSessionConfigOptionsSnapshots,
  readSessionExecutionConfigSnapshot,
} from "../acpSessionConfigSnapshots";

const gooseModelSnapshot = {
  configOptions: [
    {
      id: "provider",
      kind: { type: "select", currentValue: "databricks_v2", options: [] },
    },
    {
      id: "model",
      category: "model",
      kind: { type: "select", currentValue: "goose", options: [] },
    },
  ],
};

describe("ACP session config snapshots", () => {
  it("rejects the goose sentinel from model and execution snapshots", () => {
    expect(
      readSessionConfigOptionsSnapshots(gooseModelSnapshot).model,
    ).toBeNull();
    expect(readSessionExecutionConfigSnapshot(gooseModelSnapshot)).toBeNull();
  });

  // A session snapshot answers "which model is this session on", never "which
  // models does this provider have". goose strips the child's own `model`
  // option and rebuilds it from an inventory that is empty for every ACP
  // provider, so the values it carries are a placeholder at best. Taking them
  // for an inventory once made the app reject every real model, so the
  // contract is asserted here: one identity out, no list, whatever goes in.
  it("reports one current model and never a list of them", () => {
    const snapshotWithSeveralValues = {
      configOptions: [
        {
          id: "model",
          category: "model",
          kind: {
            type: "select",
            currentValue: "claude-sonnet-4",
            options: [
              { value: "claude-sonnet-4", name: "Claude Sonnet 4" },
              { value: "claude-opus-4", name: "Claude Opus 4" },
            ],
          },
        },
      ],
    };

    const model = readSessionConfigOptionsSnapshots(
      snapshotWithSeveralValues,
    ).model;

    expect(model).toEqual({
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
    });
    // Spelled out separately from the toEqual above so an added field fails
    // here by name rather than as an opaque object mismatch.
    expect(Object.keys(model ?? {}).sort()).toEqual(["modelId", "modelName"]);
    expect(
      Object.values(model ?? {}).some((value) => Array.isArray(value)),
    ).toBe(false);
  });

  it("reports the ACP placeholder as the current model, not as an inventory", () => {
    // What an ACP bridge actually sends: goose rebuilt the option from an
    // empty `inventory.models`, so there is a placeholder current value and no
    // values at all. Any caller reading a list here would read nothing.
    const acpSessionSnapshot = {
      configOptions: [
        {
          id: "model",
          category: "model",
          kind: { type: "select", currentValue: "current", options: [] },
        },
      ],
    };

    expect(readSessionConfigOptionsSnapshots(acpSessionSnapshot).model).toEqual(
      { modelId: "current", modelName: "current" },
    );
  });
});
