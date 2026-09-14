import { describe, expect, it } from "vitest";
import { getProviderUsageStatusKind } from "./rateLimitFormatters";
import type { ProviderRateLimits } from "./rateLimitTypes";
import { isProviderVisible } from "./rateLimitWindows";

function grokUsage(
  overrides: Partial<ProviderRateLimits> = {},
): ProviderRateLimits {
  return {
    provider: "grok-acp",
    session: null,
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

describe("getProviderUsageStatusKind", () => {
  it("offers sign-in for an expired Grok sign-in and keeps it in the bar", () => {
    // The shape grok.rs returns for an expired token: an unconfigured error
    // that still carries the account it belonged to.
    const expired = grokUsage({
      status: "error",
      configured: false,
      accountLabel: "dev@example.com",
      error: "Grok sign-in expired — sign in to Grok again",
    });

    expect(getProviderUsageStatusKind(expired)).toBe("sign-in");
    expect(isProviderVisible(expired)).toBe(true);
  });

  it("reports a failed refresh for a configured account whose fetch failed", () => {
    const failed = grokUsage({
      status: "error",
      configured: true,
      error: "Grok usage request failed (HTTP 500)",
    });

    expect(getProviderUsageStatusKind(failed)).toBe("refresh-failed");
  });
});
