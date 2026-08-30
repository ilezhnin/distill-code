import { describe, expect, it } from "vitest";
import {
  STEERING_SUPPORTED_HARNESS_IDS,
  supportsSteeringHarness,
} from "../steeringSupport";
import { TRACKED_AGENT_PLATFORM_IDS } from "@/features/status/lib/rateLimitTypes";

describe("supportsSteeringHarness", () => {
  it("covers goose and every agent platform Distill tracks", () => {
    expect(supportsSteeringHarness("goose")).toBe(true);
    for (const platform of TRACKED_AGENT_PLATFORM_IDS) {
      expect(supportsSteeringHarness(platform)).toBe(true);
    }
    // The tracked platforms plus Goose itself: a harness added to the product
    // without a steer behind it should fail here rather than silently inherit
    // an affordance nobody exercised.
    expect(STEERING_SUPPORTED_HARNESS_IDS.size).toBe(
      TRACKED_AGENT_PLATFORM_IDS.length + 1,
    );
  });

  it("refuses an unknown or absent harness", () => {
    expect(supportsSteeringHarness("some-future-harness")).toBe(false);
    expect(supportsSteeringHarness(null)).toBe(false);
    expect(supportsSteeringHarness(undefined)).toBe(false);
    expect(supportsSteeringHarness("")).toBe(false);
  });
});
