import { describe, expect, it } from "vitest";
import { supportsSteeringHarness } from "../steeringSupport";

describe("native steering availability", () => {
  it.each([
    "claude-acp",
    "kimi-acp",
  ])("exposes %s, whose adapter has a host-owned idle fallback", (harness) => {
    expect(supportsSteeringHarness(harness)).toBe(true);
  });
  it.each([
    "codex-acp",
    "goose",
    "unknown",
    "",
    null,
    undefined,
  ])("keeps %s on the queue path", (harness) => {
    expect(supportsSteeringHarness(harness)).toBe(false);
  });
});
