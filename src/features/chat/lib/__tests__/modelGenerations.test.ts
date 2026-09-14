import { describe, expect, it } from "vitest";
import type { ModelOption } from "../../types";
import {
  claudeModelSortOrder,
  groupModelsByGeneration,
} from "../modelGenerations";

function model(id: string, displayName: string): ModelOption {
  return { id, name: displayName, displayName, providerId: "claude-acp" };
}

describe("groupModelsByGeneration", () => {
  it("folds Fable 5 under Fable 5.1", () => {
    const fable51 = model("claude-fable-5-1[1m]", "Fable 5.1");
    const fable5 = model("claude-fable-5[1m]", "Fable 5");
    const opus = model("opus[1m]", "Opus 5");

    expect(groupModelsByGeneration([opus, fable5, fable51])).toEqual({
      current: [opus, fable51],
      legacy: [fable5],
    });
  });

  it("places an alias row by the generation its label names", () => {
    const opusDefault = model("default", "Opus 5");
    const opus48 = model("claude-opus-4-8", "Opus 4.8");

    expect(groupModelsByGeneration([opusDefault, opus48])).toEqual({
      current: [opusDefault],
      legacy: [opus48],
    });
  });

  it("keeps an alias whose label names no generation current", () => {
    const sonnet = model("sonnet", "Sonnet");
    const sonnet46 = model("claude-sonnet-4-6", "Sonnet 4.6");

    expect(groupModelsByGeneration([sonnet, sonnet46]).legacy).toEqual([]);
  });
});

describe("claudeModelSortOrder", () => {
  it("orders Fable, Opus, Sonnet, Haiku with the newest generation first", () => {
    const rows = [
      model("haiku", "Haiku 4.5"),
      model("claude-opus-4-8", "Opus 4.8"),
      model("sonnet", "Sonnet 5"),
      model("opus[1m]", "Opus 5"),
      model("claude-fable-5[1m]", "Fable 5"),
      model("claude-fable-5-1[1m]", "Fable 5.1"),
    ];

    const sorted = [...rows].sort(
      (left, right) =>
        (claudeModelSortOrder(left) ?? 0) - (claudeModelSortOrder(right) ?? 0),
    );

    expect(sorted.map((row) => row.displayName)).toEqual([
      "Fable 5.1",
      "Fable 5",
      "Opus 5",
      "Opus 4.8",
      "Sonnet 5",
      "Haiku 4.5",
    ]);
  });

  it("gives no order to models it cannot place", () => {
    expect(
      claudeModelSortOrder(model("gpt-5.6-sol", "GPT 5.6 Sol")),
    ).toBeUndefined();
    expect(claudeModelSortOrder(model("sonnet", "Sonnet"))).toBeUndefined();
  });
});
