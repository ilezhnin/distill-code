import { create } from "zustand";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";

export interface AccountQuotaWait {
  retryAt: number;
  startedAt: number;
  message: string;
  accountId?: string;
  providerId?: string;
  resetTokensAvailable: boolean;
}

interface QuotaWaitData {
  kind: "account_quota_wait";
  promptNotAccepted?: boolean;
  accountId?: string;
  nextReset?: number | null;
  resetTokensAvailable?: boolean;
}

export const useAccountQuotaWaitStore = create<{
  waits: Record<string, AccountQuotaWait>;
}>(() => ({ waits: {} }));
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let monitorStarted = false;

export function accountQuotaWaitData(error: unknown): QuotaWaitData | null {
  if (!error || typeof error !== "object" || !("data" in error)) return null;
  const data = error.data;
  if (
    !data ||
    typeof data !== "object" ||
    !("kind" in data) ||
    data.kind !== "account_quota_wait"
  )
    return null;
  return data as QuotaWaitData;
}

export function isAccountQuotaWaiting(sessionId: string): boolean {
  return useAccountQuotaWaitStore.getState().waits[sessionId] !== undefined;
}

export function clearAccountQuotaWait(sessionId: string): void {
  const timer = timers.get(sessionId);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(sessionId);
  useAccountQuotaWaitStore.setState(({ waits }) => {
    const { [sessionId]: _removed, ...rest } = waits;
    return { waits: rest };
  });
  useChatStore.getState().setAccountQuotaWaitUntil(sessionId, null);
}

function startMonitor(): void {
  if (monitorStarted) return;
  monitorStarted = true;
  useChatSessionStore.subscribe((state, previous) => {
    for (const sessionId of Object.keys(
      useAccountQuotaWaitStore.getState().waits,
    )) {
      const session = state.getSession(sessionId);
      const oldSession = previous.sessions.find(
        (entry) => entry.id === sessionId,
      );
      if (!session || session.accountId !== oldSession?.accountId)
        clearAccountQuotaWait(sessionId);
    }
  });
  // Keep the provider model/ACP graph out of this send-core dependency. The
  // contract generator imports command descriptors without a live renderer.
  void import("@/features/providers/stores/providerAccountsStore").then(
    ({ useProviderAccountsStore }) =>
      useProviderAccountsStore.subscribe((state, previous) => {
        for (const [sessionId, wait] of Object.entries(
          useAccountQuotaWaitStore.getState().waits,
        )) {
          const providerId = wait.providerId;
          if (!providerId) continue;
          const routingChanged =
            state.automaticSwitching[providerId] !==
              previous.automaticSwitching[providerId] ||
            state.defaults[providerId] !== previous.defaults[providerId];
          const eligible = state.accounts.filter(
            (account) =>
              account.providerId === providerId &&
              account.enabled &&
              (account.id === wait.accountId ||
                (state.automaticSwitching[providerId] && account.autoSwitch)),
          );
          const nowReady = eligible.some((account) => {
            const status = state.statuses[account.id];
            return (
              status?.state === "ready" &&
              !status.stale &&
              status.lastUpdatedAt > wait.startedAt
            );
          });
          const newlyEligible = eligible.some(
            (account) =>
              !previous.accounts.some(
                (old) =>
                  old.id === account.id &&
                  old.enabled &&
                  old.autoSwitch === account.autoSwitch,
              ),
          );
          if (routingChanged || nowReady || newlyEligible)
            clearAccountQuotaWait(sessionId);
        }
      }),
  );
}

/** Register a deferral only after a pre-dispatch rejection or explicit rollback proof. */
export function deferForAccountQuota(
  sessionId: string,
  error: unknown,
): boolean {
  const data = accountQuotaWaitData(error);
  if (!data) return false;
  startMonitor();
  const now = Date.now();
  const reset =
    typeof data.nextReset === "number" && Number.isFinite(data.nextReset)
      ? data.nextReset * (data.nextReset < 1_000_000_000_000 ? 1000 : 1)
      : 0;
  const retryAt = reset > now ? reset + 1000 : now + 60_000;
  const session = useChatSessionStore.getState().getSession(sessionId);
  const wait: AccountQuotaWait = {
    retryAt,
    startedAt: now,
    message: "Waiting for an account quota reset. Your message remains queued.",
    accountId: data.accountId,
    providerId: session?.executionTarget?.harnessId,
    resetTokensAvailable: data.resetTokensAvailable === true,
  };
  const existing = timers.get(sessionId);
  if (existing !== undefined) clearTimeout(existing);
  useAccountQuotaWaitStore.setState(({ waits }) => ({
    waits: { ...waits, [sessionId]: wait },
  }));
  useChatStore.getState().setAccountQuotaWaitUntil(sessionId, retryAt);
  timers.set(
    sessionId,
    setTimeout(
      () => clearAccountQuotaWait(sessionId),
      Math.min(retryAt - now, 2_147_483_647),
    ),
  );
  return true;
}
