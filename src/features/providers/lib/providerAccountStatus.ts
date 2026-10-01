import type {
  ProviderAccount,
  ProviderAccountResetCredit,
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
  if (
    !status?.resetTokens?.supported ||
    status.resetTokens.available <= 0 ||
    !accountIsConnected(status)
  )
    return false;
  const inventory = status.resetTokens;
  // A cached grant remains selectable during a telemetry outage. Confirmation
  // pins its ID; the provider validates that exact grant when it is redeemed.
  if (inventory.credits?.length)
    return inventory.credits.some((credit) =>
      resetCreditIsAvailable(credit, now),
    );
  // An aggregate count cannot pin a grant, so it still requires fresh data.
  return (
    !accountStatusIsStale(status, now) &&
    status.state !== "error" &&
    (inventory.expiresAt === null || inventory.expiresAt > now)
  );
}

export function accountIsConnected(
  status: ProviderAccountStatus | undefined,
): boolean {
  // A telemetry failure does not revoke authorization. Adapters report
  // needs_auth separately when credentials are missing or rejected.
  return (
    status?.state === "ready" ||
    status?.state === "limited" ||
    status?.state === "error"
  );
}

export function resetCreditIsAvailable(
  credit: ProviderAccountResetCredit,
  now = Date.now(),
): boolean {
  return (
    credit.id.trim().length > 0 &&
    credit.status === "available" &&
    (credit.grantedAt === null || credit.grantedAt <= now) &&
    (credit.expiresAt === null || credit.expiresAt > now)
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
