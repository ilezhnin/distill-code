import type { ProviderRateLimits } from "./rateLimitTypes";
import {
  clampUsedPercent,
  formatDuration,
  getUsageSections,
} from "./rateLimitWindows";

export function formatUsedPercent(usedPercent: number): string {
  return `${Math.round(clampUsedPercent(usedPercent))}%`;
}

export function resetDuration(
  resetsAt: number | null | undefined,
  now = Date.now(),
): string | null {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) {
    return null;
  }
  return formatDuration(resetsAt - now);
}

export function updatedAgoParts(
  updatedAt: number,
  now = Date.now(),
):
  | { kind: "justNow" }
  | { kind: "minutes"; count: number }
  | { kind: "hours"; count: number } {
  const diff = now - updatedAt;
  if (!Number.isFinite(diff) || diff < 60_000) return { kind: "justNow" };
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return { kind: "minutes", count: minutes };
  return { kind: "hours", count: Math.floor(minutes / 60) };
}

/** Whole seconds until a provider-imposed usage pause ends, or null when none is set. */
export function usageRetrySeconds(
  provider: Pick<ProviderRateLimits, "usageRetryAt">,
  now: number,
): number | null {
  if (provider.usageRetryAt == null) return null;
  return Math.max(0, Math.ceil((provider.usageRetryAt - now) / 1000));
}

export function getProviderUsageStatusKind(
  provider: ProviderRateLimits,
): "ok" | "refresh-failed" | "sign-in" | "limited" | "fetching" | "paused" {
  if (provider.accountLimited) return "limited";
  if (provider.status === "idle" || provider.status === "fetching") {
    return "fetching";
  }
  if (
    (provider.status === "unavailable" || provider.status === "error") &&
    getUsageSections(provider).length === 0 &&
    !provider.configured
  ) {
    return "sign-in";
  }
  // The provider asked us to wait (429 Retry-After): nothing failed, the next
  // read is scheduled.
  if (provider.usageRetryAt != null) return "paused";
  if (provider.status === "error" && getUsageSections(provider).length === 0) {
    return "refresh-failed";
  }
  // Managed accounts have an explicit quota state. A 429 from their telemetry
  // endpoint is a failed refresh, not evidence that the account is exhausted.
  if (provider.accountId && provider.status === "error") {
    return "refresh-failed";
  }
  if (/\brate[- ]?limit/i.test(provider.error ?? "")) {
    return "limited";
  }
  return "ok";
}
