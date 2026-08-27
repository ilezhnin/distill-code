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

  // The ids on the model option are the only first-hand statement of what the
  // running agent serves, so the reader has to carry them out of the wire
  // payload rather than reducing the option to its current value.
  it("carries every model id the harness listed, grouped or not", () => {
    const snapshot = readSessionConfigOptionsSnapshots({
      configOptions: [
        {
          id: "model",
          category: "model",
          kind: {
            type: "select",
            currentValue: "current",
            options: {
              type: "grouped",
              groups: [
                {
                  name: "OpenAI",
                  options: [
                    { value: "current", name: "Current" },
                    { value: "gpt-5.6-sol[xhigh]", name: "GPT 5.6 Sol" },
                  ],
                },
              ],
            },
          },
        },
      ],
    });

    expect(snapshot.model?.availableModelIds).toEqual([
      "current",
      "gpt-5.6-sol[xhigh]",
    ]);
  });
});
