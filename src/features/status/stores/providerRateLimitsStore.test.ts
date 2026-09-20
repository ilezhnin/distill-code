import { describe, expect, it } from "vitest";
import type { ProviderRateLimits } from "../lib/rateLimitTypes";
import { mergeStale } from "./providerRateLimitsStore";

function usage(
  overrides: Partial<ProviderRateLimits> = {},
): ProviderRateLimits {
  return {
    provider: "codex-acp",
    session: {
      usedPercent: 12,
      windowMinutes: 300,
      resetsAt: 1,
      resetDescription: null,
    },
    weekly: null,
    monthly: null,
    accountLabel: null,
    updatedAt: 1,
    error: null,
    status: "ok",
    configured: true,
    ...overrides,
  };
}

describe("mergeStale", () => {
  it("drops cached windows when the next fetch is an expired sign-in", () => {
    const previous = [usage()];
    const next = [
      usage({
        session: null,
        status: "error",
        configured: false,
        error: "Codex usage request unauthorized (HTTP 401): token_revoked",
      }),
    ];

    expect(mergeStale(previous, next)[0].session).toBeNull();
    expect(mergeStale(previous, next)[0].configured).toBe(false);
  });

  it("keeps cached windows across a configured refresh failure", () => {
    const previous = [usage()];
    const next = [
      usage({
        session: null,
        status: "error",
        configured: true,
        error: "Codex usage request failed (HTTP 500)",
      }),
    ];

    expect(mergeStale(previous, next)[0].session).toEqual(previous[0].session);
  });
});
