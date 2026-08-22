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

export function getProviderUsageStatusKind(
  provider: ProviderRateLimits,
): "ok" | "refresh-failed" | "sign-in" | "limited" | "fetching" {
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
  if (provider.status === "error" && getUsageSections(provider).length === 0) {
    return "refresh-failed";
  }
  if (/\brate[- ]?limit/i.test(provider.error ?? "")) {
    return "limited";
  }
  return "ok";
}
