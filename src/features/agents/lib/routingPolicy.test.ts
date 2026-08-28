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
    const ordered = applyClassOverride(shipped, ["Opus 5", "Grok 4.6"]);
    expect(ordered.map((candidate) => candidate.label)).toEqual([
      "Opus 5",
      "Grok 4.6",
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
});
