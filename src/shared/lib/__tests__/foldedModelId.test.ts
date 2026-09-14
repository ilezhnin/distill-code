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

  it("reads an effort written in any case as its own value id", () => {
    expect(splitLegacyFoldedModelId("gpt-5.6-sol[Ultra]")).toEqual({
      modelId: "gpt-5.6-sol",
      effort: "ultra",
    });
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

  it.each([
    ["a bare id", "gpt-5.6-sol"],
    ["an unknown suffix", "gpt-5.6-sol[banana]"],
    ["a numeric suffix", "claude-sonnet-4-6[200k]"],
    ["nested brackets", "gpt-5.6-sol[[low]]"],
    ["a doubled suffix", "gpt-5.6-sol[low][high]"],
    ["whitespace inside the suffix", "gpt-5.6-sol[ ultra ]"],
    ["an empty suffix", "gpt-5.6-sol[]"],
    ["a suffix with no model", "[low]"],
    ["an unterminated suffix", "gpt-5.6-sol[low"],
    ["trailing text", "gpt-5.6-sol[low] (fast)"],
    ["an empty id", ""],
    ["blank space", "   "],
  ])("returns null for %s", (_label, id) => {
    expect(splitLegacyFoldedModelId(id)).toBeNull();
  });

  it("returns null for a missing id", () => {
    expect(splitLegacyFoldedModelId(undefined)).toBeNull();
    expect(splitLegacyFoldedModelId(null)).toBeNull();
  });

  it("splits an id that arrived padded with whitespace", () => {
    expect(splitLegacyFoldedModelId("  gpt-5.6-sol[ultra]  ")).toEqual({
      modelId: "gpt-5.6-sol",
      effort: "ultra",
    });
  });
});

describe("baseModelId", () => {
  it("keeps an id that names only a model", () => {
    expect(baseModelId("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(baseModelId("  claude-opus-4-6  ")).toBe("claude-opus-4-6");
  });

  it("drops the effort half of a folded id", () => {
    expect(baseModelId("gpt-5.6-sol[ultra]")).toBe("gpt-5.6-sol");
  });

  it("reports a blank id as no model at all", () => {
    expect(baseModelId("")).toBeUndefined();
    expect(baseModelId("   ")).toBeUndefined();
    expect(baseModelId(undefined)).toBeUndefined();
    expect(baseModelId(null)).toBeUndefined();
  });
});

describe("sameModelIdentity", () => {
  it("matches a folded id against its own base, in either order", () => {
    expect(sameModelIdentity("gpt-5.6-sol[ultra]", "gpt-5.6-sol")).toBe(true);
    expect(sameModelIdentity("gpt-5.6-sol", "gpt-5.6-sol[ultra]")).toBe(true);
  });

  it("matches two efforts of one model", () => {
    expect(sameModelIdentity("gpt-5.6-sol[low]", "gpt-5.6-sol[ultra]")).toBe(
      true,
    );
  });

  it("separates two models", () => {
    expect(sameModelIdentity("gpt-5.6-sol[ultra]", "gpt-6-astra[ultra]")).toBe(
      false,
    );
    expect(sameModelIdentity("gpt-5.6-sol", "gpt-5.5")).toBe(false);
  });

  it("separates a context lane from the model without it", () => {
    expect(sameModelIdentity("opus[1m]", "opus")).toBe(false);
    expect(
      sameModelIdentity("claude-fable-5-1[1m]", "claude-fable-5[1m]"),
    ).toBe(false);
  });

  it("treats two blank ids as the same absent model", () => {
    expect(sameModelIdentity(undefined, undefined)).toBe(true);
    expect(sameModelIdentity("", "   ")).toBe(true);
    expect(sameModelIdentity(undefined, "gpt-5.6-sol")).toBe(false);
  });
});
