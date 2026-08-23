import type {
  ProviderRateLimits,
  RateLimitWindow,
  UsageSection,
} from "./rateLimitTypes";

export function clampUsedPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function hasUsageData(provider: ProviderRateLimits): boolean {
  return Boolean(
    provider.session ||
      provider.weekly ||
      provider.fableWeekly ||
      provider.monthly,
  );
}

export function isProviderVisible(provider: ProviderRateLimits): boolean {
  if (provider.status === "unavailable" && !provider.configured) {
    return false;
  }
  if (
    provider.status === "fetching" &&
    !hasUsageData(provider) &&
    !provider.configured
  ) {
    return false;
  }
  return (
    provider.configured || hasUsageData(provider) || provider.status === "error"
  );
}

export function getUsageSections(provider: ProviderRateLimits): UsageSection[] {
  const sections: UsageSection[] = [];
  if (provider.session) {
    sections.push({
      key: "session",
      label: "session",
      shortLabel: formatWindowLength(provider.session.windowMinutes),
      window: provider.session,
    });
  }
  if (provider.weekly) {
    sections.push({
      key: "weekly",
      label: "weekly",
      shortLabel: "wk",
      window: provider.weekly,
    });
  }
  if (provider.fableWeekly) {
    sections.push({
      key: "fableWeekly",
      label: "fable",
      shortLabel: "Fable",
      window: provider.fableWeekly,
    });
  }
  if (provider.monthly && !provider.session && !provider.weekly) {
    sections.push({
      key: "monthly",
      label: "monthly",
      shortLabel: formatWindowLength(provider.monthly.windowMinutes),
      window: provider.monthly,
    });
  }
  return sections;
}

export function getTightestUsageSection(
  provider: ProviderRateLimits,
): UsageSection | null {
  const sections = getUsageSections(provider);
  if (sections.length === 0) return null;
  return sections.reduce((current, candidate) =>
    clampUsedPercent(candidate.window.usedPercent) >
    clampUsedPercent(current.window.usedPercent)
      ? candidate
      : current,
  );
}

export function providerMaxUsed(provider: ProviderRateLimits): number {
  const sections = getUsageSections(provider);
  if (sections.length === 0) return 0;
  return Math.max(
    ...sections.map((section) => clampUsedPercent(section.window.usedPercent)),
  );
}

export function soonestResetAt(provider: ProviderRateLimits): number | null {
  const resets = getUsageSections(provider)
    .map((section) => section.window.resetsAt)
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    );
  if (resets.length === 0) return null;
  return Math.min(...resets);
}

export function formatWindowLength(windowMinutes: number): string {
  if (windowMinutes >= 40_000) return "mo";
  if (windowMinutes >= 1_000) return "wk";
  if (windowMinutes >= 60) return `${Math.round(windowMinutes / 60)}h`;
  return `${Math.max(1, Math.round(windowMinutes))}m`;
}

export function remainingDurationLabel(
  window: RateLimitWindow,
  now = Date.now(),
): string {
  if (typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)) {
    return formatDuration(window.resetsAt - now);
  }
  return formatWindowLength(window.windowMinutes);
}

export function formatDuration(deltaMs: number): string {
  if (!Number.isFinite(deltaMs) || deltaMs <= 30_000) return "now";
  const totalMinutes = Math.round(deltaMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes - days * 60 * 24) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}

export function barColorClass(usedPercent: number): string {
  const used = clampUsedPercent(usedPercent);
  if (used < 60) return "bg-muted-foreground/40";
  if (used < 80) return "bg-warning";
  return "bg-destructive";
}

export function usageTextClass(usedPercent: number): string {
  const used = clampUsedPercent(usedPercent);
  if (used < 80) return "text-foreground";
  return "text-destructive";
}
