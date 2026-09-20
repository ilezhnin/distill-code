import { describe, expect, it } from "vitest";
import { getProviderUsageStatusKind } from "./rateLimitFormatters";
import type { ProviderRateLimits } from "./rateLimitTypes";
import { isListedUsageProvider, isProviderVisible } from "./rateLimitWindows";

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

  it("offers sign-in for a revoked Codex token instead of Limited or Refresh failed", () => {
    const revoked = grokUsage({
      provider: "codex-acp",
      status: "error",
      configured: false,
      error:
        'Codex usage request unauthorized (HTTP 401): { "error": { "message": "Encountered invalidated oauth token for user, failing request", "code": "token_revoked" } }',
    });

    expect(getProviderUsageStatusKind(revoked)).toBe("sign-in");
    expect(isProviderVisible(revoked)).toBe(true);
  });
});

describe("isListedUsageProvider", () => {
  it("keeps an installed harness in the bar while usage is still idle", () => {
    const idle = grokUsage({
      status: "idle",
      configured: false,
      updatedAt: 0,
    });
    expect(isProviderVisible(idle)).toBe(false);
    expect(isListedUsageProvider(idle, true)).toBe(true);
    expect(isListedUsageProvider(idle, false)).toBe(false);
  });

  it("keeps an installed harness in the bar when usage cannot see its login", () => {
    const hidden = grokUsage({
      status: "unavailable",
      configured: false,
      error: "Not signed in to Grok — run grok login",
    });
    expect(isProviderVisible(hidden)).toBe(false);
    expect(isListedUsageProvider(hidden, true)).toBe(true);
  });
});
