import { afterEach, describe, expect, it } from "vitest";

import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { readSessionConfigOptionsSnapshots } from "../acpSessionConfigSnapshots";

describe("ACP session config snapshots", () => {
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

describe("the reasoning effort menu", () => {
  it("lists grok's strongest-first efforts weakest first and keeps its current value", () => {
    const grokSession = {
      configOptions: [
        {
          id: "reasoning_effort",
          category: "thought_level",
          kind: {
            type: "select",
            currentValue: "low",
            options: [
              { value: "xhigh", name: "Extra high" },
              { value: "high", name: "High" },
              { value: "medium", name: "Medium" },
              { value: "low", name: "Low effort" },
            ],
          },
        },
      ],
    };

    const effort =
      readSessionConfigOptionsSnapshots(grokSession).reasoningEffort;

    expect(effort?.configId).toBe("reasoning_effort");
    expect(effort?.currentValue).toBe("low");
    expect(effort?.options).toEqual([
      { id: "low", name: "Low effort" },
      { id: "medium", name: "Medium" },
      { id: "high", name: "High" },
      { id: "xhigh", name: "Extra high" },
    ]);
  });
});

describe("a replayed model snapshot with an effort folded into the model id", () => {
  // What an older host recorded in `session_events`, replayed verbatim on
  // session/load: the effort glued onto the model id, in the options as well.
  const replayedFoldedSnapshot = {
    configOptions: [
      {
        id: "model",
        category: "model",
        kind: {
          type: "select",
          currentValue: "gpt-5.6-sol[low]",
          options: [
            { value: "gpt-5.6-sol[low]", name: "GPT-5.6 Sol (low)" },
            { value: "gpt-5.6-sol[high]", name: "GPT-5.6 Sol (high)" },
          ],
        },
      },
    ],
  };

  function seedInventory(modelIds: string[]): void {
    useProviderModelCacheStore.setState({
      providers: new Map([
        [
          "codex-acp",
          {
            providerId: "codex-acp",
            models: modelIds.map((id) => ({ id, name: id })),
            fetchedAt: Date.now(),
          },
        ],
      ]),
    });
  }

  afterEach(() => {
    useProviderModelCacheStore.setState({ providers: new Map() });
  });

  it("is read as the base model when the inventory lists the base", () => {
    seedInventory(["gpt-5.6-sol", "gpt-5.6-luna"]);

    expect(
      readSessionConfigOptionsSnapshots(replayedFoldedSnapshot).model,
    ).toEqual({ modelId: "gpt-5.6-sol", modelName: "gpt-5.6-sol" });
  });

  it("is kept verbatim when no authoritative inventory lists the base", () => {
    expect(
      readSessionConfigOptionsSnapshots(replayedFoldedSnapshot).model,
    ).toEqual({ modelId: "gpt-5.6-sol[low]", modelName: "GPT-5.6 Sol (low)" });
  });

  it("is kept verbatim when the inventory lists the bracketed id as a model of its own", () => {
    seedInventory(["gpt-5.6-sol", "gpt-5.6-sol[low]"]);

    expect(
      readSessionConfigOptionsSnapshots(replayedFoldedSnapshot).model?.modelId,
    ).toBe("gpt-5.6-sol[low]");
  });
});
