import type {
  ProviderAccount,
  ProviderAccountStatus,
} from "../api/providerAccounts";

export function accountStatusIsStale(
  status: ProviderAccountStatus | undefined,
  now = Date.now(),
): boolean {
  return (
    !status ||
    status.stale ||
    status.lastUpdatedAt <= 0 ||
    now - status.lastUpdatedAt > 120_000
  );
}

export function canUseAccountReset(
  status: ProviderAccountStatus | undefined,
  now = Date.now(),
): boolean {
  return Boolean(
    status?.resetTokens?.supported &&
      status.resetTokens.available > 0 &&
      !accountStatusIsStale(status, now) &&
      (status.resetTokens.expiresAt === null ||
        status.resetTokens.expiresAt > now),
  );
}

export function earliestAccountReset(
  accounts: ProviderAccount[],
  statuses: Record<string, ProviderAccountStatus>,
  now = Date.now(),
): number | null {
  const candidates = accounts.filter(
    (account) => account.enabled && account.autoSwitch,
  );
  if (
    !candidates.length ||
    candidates.some(
      (account) =>
        statuses[account.id]?.state !== "limited" ||
        accountStatusIsStale(statuses[account.id], now),
    )
  )
    return null;
  const blockingWindows = candidates.map((account) =>
    statuses[account.id].limits.filter(
      (limit) =>
        limit.modelId === null &&
        ((limit.usedPercent !== null && limit.usedPercent >= 100) ||
          limit.remaining === 0),
    ),
  );
  // A model-specific limit does not make every model on an account unusable.
  if (blockingWindows.some((limits) => limits.length === 0)) return null;
  const times = blockingWindows.flatMap((limits) => {
    if (
      limits.some((limit) => limit.resetsAt === null || limit.resetsAt <= now)
    )
      return [];
    // All exhausted windows must reset before this account becomes usable.
    return [Math.max(...limits.map((limit) => limit.resetsAt as number))];
  });
  return times.length ? Math.min(...times) : null;
}

export function resetCountdown(
  resetsAt: number,
  now = Date.now(),
): { hours: number; minutes: number } {
  const minutes = Math.max(0, Math.ceil((resetsAt - now) / 60_000));
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}
