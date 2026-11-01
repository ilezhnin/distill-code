import { describe, expect, it } from "vitest";

import type { ProviderRateLimits, RateLimitWindow } from "./rateLimitTypes";
import { platformLimitState, platformUsedPercent } from "./rateLimitWindows";

function window(usedPercent: number): RateLimitWindow {
  return {
    usedPercent,
    windowMinutes: 10_080,
    resetsAt: null,
    resetDescription: null,
  };
}

function provider(overrides: Partial<ProviderRateLimits>): ProviderRateLimits {
  return {
    provider: "codex-acp",
    session: null,
    weekly: null,
    updatedAt: 1,
    error: null,
    status: "ok",
    configured: true,
    ...overrides,
  };
}

describe("platformUsedPercent", () => {
  it("is the fullest window the candidate spends, never one scoped to another model", () => {
    const providers = [
      provider({
        session: window(20),
        weekly: window(98),
        fableWeekly: window(5),
      }),
    ];
    expect(platformUsedPercent(providers, "codex-acp")).toBe(98);
    expect(
      platformUsedPercent(providers, "codex-acp", {
        scopedWindow: "fableWeekly",
      }),
    ).toBe(98);
    // Fable's own window does not fill up a model that never spends it.
    expect(
      platformUsedPercent(
        [provider({ session: window(20), fableWeekly: window(99) })],
        "codex-acp",
      ),
    ).toBe(20);
  });

  it("has no number for a platform that reports no usage", () => {
    expect(platformUsedPercent([provider({})], "codex-acp")).toBeUndefined();
    expect(
      platformUsedPercent([provider({ weekly: window(50) })], "grok-acp"),
    ).toBeUndefined();
  });

  it("is the number platformLimitState judges", () => {
    const providers = [provider({ weekly: window(98) })];
    expect(
      platformLimitState(providers, "codex-acp", { nearLimitPercent: 85 }),
    ).toBe("near-limit");
    expect(
      platformLimitState(providers, "codex-acp", { nearLimitPercent: 99 }),
    ).toBe("clear");
  });
});
