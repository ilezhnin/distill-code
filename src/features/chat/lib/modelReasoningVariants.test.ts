import { describe, expect, it } from "vitest";
import {
  collapseEmbeddedReasoningModels,
  composeEmbeddedReasoningModelId,
  grokReasoningEffortConfig,
  splitEmbeddedReasoning,
  stripEmbeddedReasoningLabel,
} from "./modelReasoningVariants";

describe("modelReasoningVariants", () => {
  it("splits trailing effort suffixes from wire ids", () => {
    expect(splitEmbeddedReasoning("gpt-5.4-mini[high]")).toEqual({
      base: "gpt-5.4-mini",
      effort: "high",
    });
    expect(splitEmbeddedReasoning("GPT 5.4 Mini[xhigh]")).toEqual({
      base: "GPT 5.4 Mini",
      effort: "xhigh",
    });
    expect(splitEmbeddedReasoning("grok-4.6")).toBeNull();
    expect(splitEmbeddedReasoning("claude-opus-4-6[ultrathink]")).toEqual({
      base: "claude-opus-4-6",
      effort: "ultrathink",
    });
    expect(splitEmbeddedReasoning("claude-sonnet-4-6[max]")).toEqual({
      base: "claude-sonnet-4-6",
      effort: "max",
    });
    expect(splitEmbeddedReasoning("claude-opus-4-6[thinking]")).toEqual({
      base: "claude-opus-4-6",
      effort: "thinking",
    });
    expect(splitEmbeddedReasoning("claude-opus-4-6[1m]")).toBeNull();
    expect(splitEmbeddedReasoning("gpt-5.6-sol[ultra]")).toEqual({
      base: "gpt-5.6-sol",
      effort: "ultra",
    });
  });

  it("collapses Claude thinking suffixes into one model plus a reasoning list", () => {
    const collapsed = collapseEmbeddedReasoningModels(
      [
        {
          id: "claude-opus-4-6[think]",
          name: "Opus 4.6[think]",
          providerId: "claude-acp",
        },
        {
          id: "claude-opus-4-6[ultrathink]",
          name: "Opus 4.6[ultrathink]",
          providerId: "claude-acp",
        },
        {
          id: "claude-sonnet-4-6[max]",
          name: "Sonnet 4.6[max]",
          providerId: "claude-acp",
        },
        {
          id: "claude-sonnet-4-6[thinking]",
          name: "Sonnet 4.6[thinking]",
          providerId: "claude-acp",
        },
      ],
      "claude-opus-4-6[ultrathink]",
    );

    expect(collapsed.models.map((model) => model.id)).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]);
    expect(collapsed.models[0]?.displayName).toBe("Opus 4.6");
    expect(collapsed.reasoning?.options.map((option) => option.id)).toEqual([
      "think",
      "thinking",
      "max",
      "ultrathink",
    ]);
    expect(collapsed.reasoning?.currentValue).toBe("ultrathink");
    expect(
      composeEmbeddedReasoningModelId("claude-opus-4-6", "think", collapsed),
    ).toBe("claude-opus-4-6[think]");
  });

  it("collapses effort-suffixed models into one row per model plus a reasoning list", () => {
    const collapsed = collapseEmbeddedReasoningModels(
      [
        {
          id: "gpt-5.4-mini[low]",
          name: "GPT 5.4 Mini[low]",
          providerId: "codex-acp",
        },
        {
          id: "gpt-5.4-mini[high]",
          name: "GPT 5.4 Mini[high]",
          providerId: "codex-acp",
        },
        {
          id: "gpt-5.4[medium]",
          name: "GPT 5.4[medium]",
          providerId: "codex-acp",
        },
        {
          id: "gpt-5.4[xhigh]",
          name: "GPT 5.4[xhigh]",
          providerId: "codex-acp",
        },
      ],
      "gpt-5.4-mini[high]",
    );

    expect(collapsed.models.map((model) => model.id)).toEqual([
      "gpt-5.4-mini",
      "gpt-5.4",
    ]);
    expect(collapsed.models[0]?.displayName).toBe("GPT 5.4 Mini");
    expect(collapsed.reasoning).toMatchObject({
      currentValue: "high",
      options: [
        { id: "low", name: "low" },
        { id: "medium", name: "medium" },
        { id: "high", name: "high" },
        { id: "xhigh", name: "xhigh" },
      ],
    });
    expect(
      composeEmbeddedReasoningModelId("gpt-5.4-mini", "low", collapsed),
    ).toBe("gpt-5.4-mini[low]");
    expect(composeEmbeddedReasoningModelId("gpt-5.4", "low", collapsed)).toBe(
      "gpt-5.4[medium]",
    );
  });

  it("leaves unsuffixed lists unchanged", () => {
    const models = [
      { id: "grok-4.6", name: "Grok 4.6", providerId: "grok-acp" },
      { id: "grok-4.5", name: "Grok 4.5", providerId: "grok-acp" },
    ];
    const collapsed = collapseEmbeddedReasoningModels(models, "grok-4.6");
    expect(collapsed.models).toEqual(models);
    expect(collapsed.reasoning).toBeNull();
  });

  it("defaults Grok reasoning to high when the session only has a dummy off value", () => {
    expect(grokReasoningEffortConfig("off")).toMatchObject({
      currentValue: "high",
      options: [
        { id: "low", name: "low" },
        { id: "medium", name: "medium" },
        { id: "high", name: "high" },
        { id: "xhigh", name: "xhigh" },
      ],
    });
    expect(grokReasoningEffortConfig("low").currentValue).toBe("low");
    expect(stripEmbeddedReasoningLabel("GPT 5.4 Mini[high]")).toBe(
      "GPT 5.4 Mini",
    );
  });
});
