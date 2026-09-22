import { describe, expect, it } from "vitest";

import {
  applyClassOverride,
  KNOWN_MODEL_CANDIDATES,
  MODEL_PREFERENCE_CLASSES,
  modelPreferenceClassIds,
} from "./modelRanking";
import {
  DEFAULT_ROUTING_POLICY,
  isDefaultRoutingPolicy,
  parseRoutingPolicy,
} from "./routingPolicy";

describe("parseRoutingPolicy", () => {
  it("returns the shipped policy for nothing at all", () => {
    expect(parseRoutingPolicy(null)).toEqual(DEFAULT_ROUTING_POLICY);
    expect(isDefaultRoutingPolicy(parseRoutingPolicy(undefined))).toBe(true);
  });

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

  it("drops an override that named nothing", () => {
    expect(
      parseRoutingPolicy({ classOverrides: { "one-shot": [] } }).classOverrides,
    ).toEqual({});
  });

  it("keeps only overrides for classes that exist", () => {
    // A JSON document carries whatever keys were written into it, including
    // ones that resolve to Object.prototype members: `__proto__` would
    // re-parent the overrides object and `constructor` would shadow a
    // function with a list nothing can index. Neither is a class.
    const policy = parseRoutingPolicy({
      classOverrides: JSON.parse(
        '{"__proto__":["Opus 5"],"constructor":["Astra"],"retired-class":["Grok 4.6"],"one-shot":["Opus 5"]}',
      ),
    });
    expect(policy.classOverrides).toEqual({ "one-shot": ["Opus 5"] });
    expect(Object.getPrototypeOf(policy.classOverrides)).toBe(Object.prototype);
    expect(Object.keys(policy.classOverrides)).toEqual(["one-shot"]);
  });

  it("is stricter about waves than about chats by default", () => {
    // A wave runs unattended and several sessions at once against one meter.
    expect(DEFAULT_ROUTING_POLICY.waveNearLimitPercent).toBeLessThan(
      DEFAULT_ROUTING_POLICY.chatNearLimitPercent,
    );
  });
});

describe("applyClassOverride", () => {
  const shipped = MODEL_PREFERENCE_CLASSES["testing-light"].ranking;

  it("uses the built-in order when the operator set none", () => {
    expect(applyClassOverride(shipped, undefined)).toBe(shipped);
  });

  it("takes the operator's order, including models from other classes", () => {
    // The whole point of the map: put the heavy model on light testing, or
    // the cheap one on complex coding, without editing an agent.
    const ordered = applyClassOverride(shipped, ["Opus 5", "Grok 4.7"]);
    expect(ordered.map((candidate) => candidate.label)).toEqual([
      "Opus 5",
      "Grok 4.7",
    ]);
  });

  it("ignores a label that names no candidate we know", () => {
    expect(
      applyClassOverride(shipped, ["Opus 5", "A model that left"]).map(
        (candidate) => candidate.label,
      ),
    ).toEqual(["Opus 5"]);
  });

  it("falls back rather than resolving to nothing", () => {
    // A class with no candidates silently stops retargeting anything, which
    // looks exactly like the feature being broken.
    expect(applyClassOverride(shipped, ["nothing", "real"])).toBe(shipped);
  });

  it("offers every class's candidates as the pool to choose from", () => {
    const labels = KNOWN_MODEL_CANDIDATES.map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const classId of modelPreferenceClassIds()) {
      for (const candidate of MODEL_PREFERENCE_CLASSES[classId].ranking) {
        expect(labels).toContain(candidate.label);
      }
    }
  });

  it("keeps a model the default order dropped in the pool", () => {
    // Taking a model out of every shipped order is not the same as saying the
    // operator may no longer choose it (Tera and Sol, 2026-09-12).
    const labels = KNOWN_MODEL_CANDIDATES.map((c) => c.label);
    expect(labels).toContain("Codex Sol");
    expect(labels).toContain("Tera");
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
