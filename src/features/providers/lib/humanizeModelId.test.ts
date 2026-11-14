import { describe, expect, it } from "vitest";
import {
  claudeModelSortOrder,
  groupModelsByGeneration,
} from "@/features/chat/lib/modelGenerations";
import { harnessModelLabel, humanizeRawModelId } from "./humanizeModelId";

describe("Claude model names", () => {
  it("reads a Mythos lane the way Claude names the model", () => {
    expect(humanizeRawModelId("claude-mythos-5-2[1m]")).toBe("Mythos 5.2");
    expect(humanizeRawModelId("claude-mythos-5-1")).toBe("Mythos 5.1");
    expect(humanizeRawModelId("claude-fable-5-2[1m]")).toBe("Fable 5.2");
    expect(
      harnessModelLabel({
        id: "claude-mythos-5-2[1m]",
        name: "Mythos 5.2",
        description: "Mythos 5.2 with 1M context",
      }),
    ).toBe("Mythos 5.2");
  });

  it("files the previous Mythos with the older models, apart from Fable's", () => {
    const model = (id: string) => ({ id, name: id });
    const { current, legacy } = groupModelsByGeneration([
      model("claude-fable-5-2[1m]"),
      model("claude-mythos-5-2[1m]"),
      model("claude-fable-5-1[1m]"),
      model("claude-mythos-5-1[1m]"),
    ]);
    expect(current.map((entry) => entry.id)).toEqual([
      "claude-fable-5-2[1m]",
      "claude-mythos-5-2[1m]",
    ]);
    expect(legacy.map((entry) => entry.id)).toEqual([
      "claude-fable-5-1[1m]",
      "claude-mythos-5-1[1m]",
    ]);
  });

  it("orders Mythos after Fable and before Opus", () => {
    const order = (id: string) =>
      claudeModelSortOrder({ id, name: id }) as number;
    expect(order("claude-fable-5-2[1m]")).toBeLessThan(
      order("claude-mythos-5-2[1m]"),
    );
    expect(order("claude-mythos-5-2[1m]")).toBeLessThan(
      order("claude-mythos-5-1[1m]"),
    );
    expect(order("claude-mythos-5-1[1m]")).toBeLessThan(
      order("claude-opus-4-8"),
    );
  });
});
