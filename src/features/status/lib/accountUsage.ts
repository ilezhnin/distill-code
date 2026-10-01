import type {
  ProviderAccount,
  ProviderAccountsSnapshot,
  ProviderAccountStatus,
} from "@/features/providers/api/providerAccounts";
import type {
  ProviderRateLimits,
  RateLimitWindow,
  UsagePeriod,
} from "./rateLimitTypes";

export function isManagedUsage(provider: string): boolean {
  return provider === "claude-acp" || provider === "codex-acp";
}

/** Shared by account cards, the account picker and the status bar. */
export function accountUsageFor(
  account: ProviderAccount,
  selected: ProviderAccountStatus | undefined,
): ProviderRateLimits {
  const status =
    selected?.accountId === account.id &&
    selected.providerId === account.providerId
      ? selected
      : undefined;
  const configured =
    account.enabled &&
    status?.state !== "needs_auth" &&
    status?.state !== "disabled";
  const usage: ProviderRateLimits = {
    provider: account.providerId,
    accountId: account.id,
    accountLimited: configured && status?.state === "limited",
    configured,
    session: null,
    weekly: null,
    fableWeekly: null,
    monthly: null,
    accountLabel: status?.accountLabel ?? account.label,
    planType: status?.subscription ?? null,
    credits: status?.credits ?? null,
    updatedAt: status?.lastAttemptAt ?? account.updatedAt,
    error: status?.error ?? null,
    status: !configured
      ? "unavailable"
      : !status
        ? "fetching"
        : status.error || status.stale || status.state === "error"
          ? "error"
          : status.state === "unknown"
            ? "unavailable"
            : "ok",
  };
  if (!configured) return usage;
  for (const limit of status?.limits ?? []) {
    if (limit.usedPercent == null || !Number.isFinite(limit.usedPercent))
      continue;
    const minutes = limit.windowMinutes;
    if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) continue;
    const period: UsagePeriod | null =
      Math.abs(minutes - 300) <= 1
        ? "session"
        : Math.abs(minutes - 10_080) <= 1
          ? "weekly"
          : minutes >= 28 * 24 * 60 && minutes <= 31 * 24 * 60
            ? "monthly"
            : null;
    if (!period) continue;
    const window: RateLimitWindow = {
      usedPercent: Math.min(100, Math.max(0, limit.usedPercent)),
      windowMinutes: minutes,
      resetsAt: limit.resetsAt,
      resetDescription: null,
    };
    const modelId = limit.modelId?.trim();
    if (
      modelId &&
      !(modelId.toLowerCase() === "fable" && period === "weekly")
    ) {
      usage.modelWindows ??= [];
      const modelWindows = usage.modelWindows;
      const prior = modelWindows.find(
        (entry) =>
          entry.modelId.toLowerCase() === modelId.toLowerCase() &&
          entry.period === period,
      );
      if (!prior) modelWindows.push({ modelId, period, window });
      else if (window.usedPercent > prior.window.usedPercent)
        prior.window = window;
      continue;
    }
    const key = modelId ? "fableWeekly" : period;
    if (!usage[key] || window.usedPercent > usage[key].usedPercent)
      usage[key] = window;
  }
  return usage;
}

/** One telemetry owner per account; the status bar shows its selected default. */
export function accountUsage(
  state: ProviderAccountsSnapshot & {
    statuses: Record<string, ProviderAccountStatus>;
  },
): ProviderRateLimits[] {
  return Object.entries(state.defaults).flatMap(([provider, id]) => {
    if (!isManagedUsage(provider)) return [];
    const account = state.accounts.find(
      (entry) => entry.id === id && entry.providerId === provider,
    );
    return account ? [accountUsageFor(account, state.statuses[id])] : [];
  });
}
