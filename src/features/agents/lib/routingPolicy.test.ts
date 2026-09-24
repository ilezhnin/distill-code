import { describe, expect, it } from "vitest";

import { applyClassOverride, MODEL_PREFERENCE_CLASSES } from "./modelRanking";
import { DEFAULT_ROUTING_POLICY, parseRoutingPolicy } from "./routingPolicy";

describe("parseRoutingPolicy", () => {
  it("keeps the good half of a half-broken document", () => {
    // One bad field must not cost the operator the other three.
    const policy = parseRoutingPolicy({
      waveNearLimitPercent: 70,
      chatNearLimitPercent: "soon",
      classOverrides: { "coding-simple": ["Opus 5"], "one-shot": "nope" },
    });
    expect(policy.waveNearLimitPercent).toBe(70);
    expect(policy.chatNearLimitPercent).toBe(
      DEFAULT_ROUTING_POLICY.chatNearLimitPercent,
    );
    expect(policy.classOverrides).toEqual({ "coding-simple": ["Opus 5"] });
  });

  it("refuses a threshold that would turn the setting into something else", () => {
    // Below 50 this stops meaning "prefer another platform" and starts
    // meaning "never use this one"; above 100 it can never fire.
    expect(
      parseRoutingPolicy({ waveNearLimitPercent: 3 }).waveNearLimitPercent,
    ).toBe(50);
    expect(
      parseRoutingPolicy({ waveNearLimitPercent: 400 }).waveNearLimitPercent,
    ).toBe(100);
  });
});

describe("applyClassOverride", () => {
  const shipped = MODEL_PREFERENCE_CLASSES["testing-light"].ranking;

  it("takes the operator's order, including models from other classes", () => {
    // The whole point of the map: put the heavy model on light testing, or
    // the cheap one on complex coding, without editing an agent.
    const ordered = applyClassOverride(shipped, ["Opus 5", "Grok 4.7"]);
    expect(ordered.map((candidate) => candidate.label)).toEqual([
      "Opus 5",
      "Grok 4.7",
    ]);
  });

  it("reads an override saved under a model's old label", () => {
    // A rename would otherwise drop the model out of the saved order and snap
    // the class back to the shipped one — a reset nobody asked for.
    expect(
      applyClassOverride(shipped, ["Fable 5", "Grok 4.6"]).map((c) => c.label),
    ).toEqual(["Fable 5.1", "Grok 4.7"]);
  });

  it("keeps the class's own effort when the operator reorders it", () => {
    // The medium profile ranks the same models as the heavy one; a reorder
    // must not silently bring them back at xhigh.
    const medium = MODEL_PREFERENCE_CLASSES["coding-simple"].ranking;
    expect(
      applyClassOverride(medium, ["Opus 5", "Astra"]).map((candidate) => [
        candidate.label,
        candidate.effort,
      ]),
    ).toEqual([
      ["Opus 5", "medium"],
      ["Astra", "medium"],
    ]);
  });
});
