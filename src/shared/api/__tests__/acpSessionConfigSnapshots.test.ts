import { afterEach, describe, expect, it } from "vitest";

import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { readSessionConfigOptionsSnapshots } from "../acpSessionConfigSnapshots";

it("keeps Antigravity's model family and thinking level as separate ACP choices", () => {
  const model = {
    id: "model",
    category: "model",
    type: "select",
    currentValue: "example-family",
    options: [{ value: "example-family", name: "Example family" }],
  };
  const thought = {
    id: "thought_level",
    category: "thought_level",
    type: "select",
    currentValue: "low",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  };
  const legacy = { currentModelId: "example-family-low" };
  expect(
    readSessionConfigOptionsSnapshots({
      models: legacy,
      configOptions: [model, thought],
    }),
  ).toMatchObject({
    model: { modelId: "example-family", modelName: "Example family" },
    reasoningEffort: {
      configId: "thought_level",
      currentValue: "low",
      options: [
        { id: "low", name: "Low" },
        { id: "high", name: "High" },
      ],
    },
  });
  expect(
    readSessionConfigOptionsSnapshots({
      models: legacy,
      configOptions: [model],
    }).reasoningEffort,
  ).toBeNull();
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
