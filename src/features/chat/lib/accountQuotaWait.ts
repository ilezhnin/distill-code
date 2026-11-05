import { create } from "zustand";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { logRendererEvent } from "@/shared/api/rendererLog";

/**
 * Why a chat's queue waits for its provider: its account's quota is spent
 * (`quota`), or the provider refused the request as rate-limited before the
 * turn began (`rate_limit`, the HTTP 429 a burst of agents on one account
 * meets). Both hold the refused message first in the queue and send it again
 * once the wait is over (LAWS/CHAT.md).
 */
export type ProviderWaitReason = "quota" | "rate_limit";

export interface AccountQuotaWait {
  retryAt: number;
  startedAt: number;
  message: string;
  reason: ProviderWaitReason;
  accountId?: string;
  providerId?: string;
  /** The provider's reset time when the host named one; null for a blind re-check. */
  resetAt: number | null;
  resetTokensAvailable: boolean;
}

/** The host's wait kinds (`agent_host/router.rs`). */
const ACCOUNT_QUOTA_WAIT = "account_quota_wait";
const PROVIDER_RATE_LIMIT_WAIT = "provider_rate_limit_wait";

interface QuotaWaitData {
  kind: typeof ACCOUNT_QUOTA_WAIT | typeof PROVIDER_RATE_LIMIT_WAIT;
  promptNotAccepted?: boolean;
  accountId?: string | null;
  nextReset?: number | null;
  resetTokensAvailable?: boolean;
  /** The provider's own words for a rate-limit refusal. */
  refused?: string;
}

/** The first wait after a rate-limit refusal; each refusal in a row doubles it. */
export const RATE_LIMIT_FIRST_WAIT_MS = 15_000;
/** The longest a rate-limited message waits between two attempts. */
export const RATE_LIMIT_MAX_WAIT_MS = 5 * 60_000;
/**
 * How far apart the waiting chats of one account are sent again. A burst of
 * agents the provider refused together would otherwise be refused together
 * again.
 */
export const RATE_LIMIT_ACCOUNT_SPACING_MS = 5_000;
/** A refusal this long after a chat's last one starts its count over. */
const RATE_LIMIT_STREAK_RESET_MS = 10 * 60_000;

export const useAccountQuotaWaitStore = create<{
  waits: Record<string, AccountQuotaWait>;
}>(() => ({ waits: {} }));
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const rateLimitStreaks = new Map<string, { count: number; at: number }>();
const nextRateLimitSlotByAccount = new Map<string, number>();
let monitorStarted = false;

/**
 * The host's word that a prompt waits for its provider — a spent quota, or a
 * rate-limit refusal before the turn began — or null for any other error.
 */
export function accountQuotaWaitData(error: unknown): QuotaWaitData | null {
  if (!error || typeof error !== "object" || !("data" in error)) return null;
  const data = error.data;
  if (
    !data ||
    typeof data !== "object" ||
    !("kind" in data) ||
    (data.kind !== ACCOUNT_QUOTA_WAIT && data.kind !== PROVIDER_RATE_LIMIT_WAIT)
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

/**
 * When a rate-limited message of `sessionId` is sent again: 15 s after the
 * first refusal, doubling with each refusal in a row up to five minutes, and
 * never within 5 s of another waiting chat of the same account, so a burst
 * the provider refused together goes back one at a time.
 */
function rateLimitRetryAt(
  sessionId: string,
  accountKey: string,
  now: number,
): { retryAt: number; attempt: number } {
  const previous = rateLimitStreaks.get(sessionId);
  const attempt =
    previous && now - previous.at < RATE_LIMIT_STREAK_RESET_MS
      ? previous.count + 1
      : 1;
  rateLimitStreaks.set(sessionId, { count: attempt, at: now });
  const wait = Math.min(
    RATE_LIMIT_FIRST_WAIT_MS * 2 ** (attempt - 1),
    RATE_LIMIT_MAX_WAIT_MS,
  );
  const slot = nextRateLimitSlotByAccount.get(accountKey);
  const retryAt = Math.max(
    now + wait,
    slot === undefined ? 0 : slot + RATE_LIMIT_ACCOUNT_SPACING_MS,
  );
  nextRateLimitSlotByAccount.set(accountKey, retryAt);
  return { retryAt, attempt };
}

export function resetRateLimitPacingForTesting(): void {
  rateLimitStreaks.clear();
  nextRateLimitSlotByAccount.clear();
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
          // A rate limit is no state of the account: a fresh status saying
          // "ready" said the same before the refusal. Only the wait itself,
          // or the chat moving to another account, ends it.
          if (wait.reason === "rate_limit") continue;
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
  const session = useChatSessionStore.getState().getSession(sessionId);
  const providerId = session?.executionTarget?.harnessId;
  const accountId = data.accountId ?? undefined;
  let wait: AccountQuotaWait;
  if (data.kind === PROVIDER_RATE_LIMIT_WAIT) {
    const { retryAt, attempt } = rateLimitRetryAt(
      sessionId,
      `${providerId ?? ""}\u0000${accountId ?? session?.accountId ?? ""}`,
      now,
    );
    wait = {
      retryAt,
      startedAt: now,
      message:
        "The provider refused the request as rate-limited. Your message remains queued.",
      reason: "rate_limit",
      accountId,
      providerId,
      resetAt: null,
      resetTokensAvailable: false,
    };
    void logRendererEvent(
      "info",
      `[queue] the provider refused the prompt of session ${sessionId} as rate-limited before the turn began (${data.refused ?? "no words given"}); refusal ${attempt} in a row, sending it again at ${new Date(retryAt).toISOString()}`,
    );
  } else {
    const reset =
      typeof data.nextReset === "number" && Number.isFinite(data.nextReset)
        ? data.nextReset * (data.nextReset < 1_000_000_000_000 ? 1000 : 1)
        : 0;
    wait = {
      retryAt: reset > now ? reset + 1000 : now + 60_000,
      startedAt: now,
      message:
        "Waiting for an account quota reset. Your message remains queued.",
      reason: "quota",
      accountId,
      providerId,
      resetAt: reset > now ? reset : null,
      resetTokensAvailable: data.resetTokensAvailable === true,
    };
  }
  const retryAt = wait.retryAt;
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
