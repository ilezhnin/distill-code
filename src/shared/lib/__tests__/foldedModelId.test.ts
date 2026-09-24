import { describe, expect, it } from "vitest";
import {
  baseModelId,
  sameModelIdentity,
  splitLegacyFoldedModelId,
} from "../foldedModelId";

describe("splitLegacyFoldedModelId", () => {
  it.each([
    ["gpt-5.6-sol[ultra]", "gpt-5.6-sol", "ultra"],
    ["gpt-6-astra[low]", "gpt-6-astra", "low"],
    ["gpt-5.6-luna[max]", "gpt-5.6-luna", "max"],
    ["gpt-5.5[xhigh]", "gpt-5.5", "xhigh"],
    ["claude-opus-4-6[minimal]", "claude-opus-4-6", "minimal"],
    ["grok-4.6[off]", "grok-4.6", "off"],
  ])("splits %s into its model and its effort", (id, modelId, effort) => {
    expect(splitLegacyFoldedModelId(id)).toEqual({ modelId, effort });
  });

  // A context lane is part of the model id the Claude harness matches, not an
  // effort. Splitting one would break every Claude extra.
  it.each([
    "opus[1m]",
    "claude-fable-5[1m]",
    "claude-fable-5-1[1m]",
  ])("never splits the context lane %s", (id) => {
    expect(splitLegacyFoldedModelId(id)).toBeNull();
    expect(baseModelId(id)).toBe(id);
  });
});

describe("sameModelIdentity", () => {
  it("separates a context lane from the model without it", () => {
    expect(sameModelIdentity("opus[1m]", "opus")).toBe(false);
    expect(
      sameModelIdentity("claude-fable-5-1[1m]", "claude-fable-5[1m]"),
    ).toBe(false);
  });
});
