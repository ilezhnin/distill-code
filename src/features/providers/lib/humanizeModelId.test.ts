import { describe, expect, it } from "vitest";
import { harnessModelLabel, humanizeRawModelId } from "./humanizeModelId";

describe("humanizeRawModelId", () => {
  it.each([
    ["claude-fable-5-1[1m]", "Fable 5.1"],
    ["claude-fable-5[1m]", "Fable 5"],
    ["claude-opus-4-8", "Opus 4.8"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"],
  ])("names %s the way Claude Code does", (id, label) => {
    expect(humanizeRawModelId(id)).toBe(label);
  });

  it.each([
    ["gpt-5-codex", "GPT 5 Codex"],
    ["grok-4.6", "Grok 4.6"],
    ["claude-3-5-sonnet", "Claude 3.5 Sonnet"],
  ])("keeps the generic spelling for %s", (id, label) => {
    expect(humanizeRawModelId(id)).toBe(label);
  });
});

describe("harnessModelLabel", () => {
  it("labels a Claude Code row by the model its description names", () => {
    expect(
      harnessModelLabel({
        id: "default",
        description:
          "Opus 5 with 1M context · Best for everyday, complex tasks",
      }),
    ).toBe("Opus 5");
    expect(
      harnessModelLabel({ id: "haiku", description: "Haiku 4.5 · Fastest" }),
    ).toBe("Haiku 4.5");
  });

  it("names a row the way its harness spells it", () => {
    expect(
      harnessModelLabel({
        id: "gpt-5.6-sol",
        name: "GPT-5.6-Sol",
        description: "Reliable agentic workhorse for everyday tasks.",
      }),
    ).toBe("GPT-5.6-Sol");
  });

  it("labels a Claude alias by the model it resolves to, not by the alias", () => {
    // "default" and "opus[1m]" are one model listed twice; naming the alias
    // row after the model is also what pairs it with its twin.
    expect(
      harnessModelLabel({
        id: "default",
        name: "Default (recommended)",
        description: "Opus 5 with 1M context · Best for everyday tasks",
      }),
    ).toBe("Opus 5");
  });

  it("falls back to the id for a row the host did not name", () => {
    expect(
      harnessModelLabel({
        id: "gpt-5.6-luna",
        description: "Fast and affordable agentic coding model.",
      }),
    ).toBe(humanizeRawModelId("gpt-5.6-luna"));
    // A bridge row with no name of its own arrives carrying its id.
    expect(
      harnessModelLabel({ id: "gpt-5.6-luna", name: "gpt-5.6-luna" }),
    ).toBe("GPT 5.6 Luna");
    expect(harnessModelLabel({ id: "claude-fable-5-1[1m]" })).toBe("Fable 5.1");
  });
});
