import { describe, expect, it } from "vitest";
import { supportsSteeringHarness } from "../steeringSupport";
import { TRACKED_AGENT_PLATFORM_IDS } from "@/features/status/lib/rateLimitTypes";

describe("supportsSteeringHarness", () => {
  it("covers every agent platform Distill tracks", () => {
    for (const platform of TRACKED_AGENT_PLATFORM_IDS) {
      expect(supportsSteeringHarness(platform)).toBe(true);
    }
  });

  it("refuses an absent harness", () => {
    expect(supportsSteeringHarness(null)).toBe(false);
    expect(supportsSteeringHarness(undefined)).toBe(false);
    expect(supportsSteeringHarness("")).toBe(false);
  });
});
