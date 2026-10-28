import { describe, expect, it } from "vitest";
import { supportsSteeringHarness } from "../steeringSupport";

describe("native steering availability", () => {
  it("exposes the adapter with a host-owned idle fallback", () => {
    expect(supportsSteeringHarness("claude-acp")).toBe(true);
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
