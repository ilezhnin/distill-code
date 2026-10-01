import { create } from "zustand";
import { useProviderAccountsStore } from "@/features/providers/stores/providerAccountsStore";
import { getPreferenceStorage } from "@/shared/preferences/rootSettings";
import { getProviderRateLimits } from "../api/providerRateLimits";
import { accountUsage, isManagedUsage } from "../lib/accountUsage";
import type {
  ProviderRateLimitSnapshot,
  ProviderRateLimits,
  StatusBarUsageMode,
} from "../lib/rateLimitTypes";
import {
  STATUS_BAR_EMPTY_CTA_DISMISSED_KEY,
  STATUS_BAR_USAGE_MODE_KEY,
} from "../lib/rateLimitTypes";
import { hasUsageData } from "../lib/rateLimitWindows";

const POLL_MS = 2 * 60 * 1000;

function readUsageMode(): StatusBarUsageMode {
  if (typeof window === "undefined") return "verbose";
  return getPreferenceStorage()?.getItem(STATUS_BAR_USAGE_MODE_KEY) ===
    "compact"
    ? "compact"
    : "verbose";
}

function readEmptyCtaDismissed(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.localStorage.getItem(STATUS_BAR_EMPTY_CTA_DISMISSED_KEY) === "1"
  );
}

export function mergeStale(
  previous: ProviderRateLimits[] | undefined,
  next: ProviderRateLimits[],
): ProviderRateLimits[] {
  if (!previous) return next;
  const previousById = new Map(
    previous.map((provider) => [provider.provider, provider]),
  );
  return next.map((provider) => {
    const prior = previousById.get(provider.provider);
    if (
      !prior ||
      prior.accountId !== provider.accountId ||
      (!hasUsageData(prior) && !prior.credits?.length)
    )
      return provider;
    // Managed accounts own stale retention too. An authoritative empty
    // snapshot (for example OAuth -> API billing) must clear old windows.
    if (isManagedUsage(provider.provider) && provider.accountId)
      return provider;
    if (hasUsageData(provider) || provider.status === "ok") return provider;
    // A dead or expired sign-in is not a blip: keep the error, drop the
    // previous windows so the roster offers Sign in instead of stale usage.
    if (!provider.configured) return provider;
    return {
      ...provider,
      session: provider.session ?? prior.session,
      weekly: provider.weekly ?? prior.weekly,
      fableWeekly: provider.fableWeekly ?? prior.fableWeekly,
      monthly: provider.monthly ?? prior.monthly,
      codingMonthly: provider.codingMonthly ?? prior.codingMonthly,
      accountLabel: provider.accountLabel ?? prior.accountLabel,
      planType: provider.planType ?? prior.planType,
      credits: provider.credits ?? prior.credits,
      error: provider.error ?? prior.error,
    };
  });
}

/**
 * Deep equality for the plain data a fetch returns, where a missing field and
 * an `undefined` one mean the same thing (`mergeStale` spreads both kinds).
 */
function sameUsageValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftFields = left as Record<string, unknown>;
  const rightFields = right as Record<string, unknown>;
  const keys = new Set([
    ...Object.keys(leftFields),
    ...Object.keys(rightFields),
  ]);
  for (const key of keys) {
    if (!sameUsageValue(leftFields[key], rightFields[key])) return false;
  }
  return true;
}

/**
 * Whether a fetched provider says what the one already shown says. The fetch
 * time is left out: it is new on every poll even when nothing else is.
 */
function sameProviderUsage(
  left: ProviderRateLimits,
  right: ProviderRateLimits,
): boolean {
  return sameUsageValue(
    { ...left, updatedAt: undefined },
    { ...right, updatedAt: undefined },
  );
}

/**
 * The fetched providers, reusing each object already shown whose usage did
 * not change, and the previous array itself when none did.
 *
 * Every poll used to hand subscribers new objects, so the status bar, each
 * `useAgentProviderStatus` consumer and the new-chat session preparation
 * recomputed every two minutes with nothing to show for it. A kept object
 * keeps the fetch time it came with; the time of the latest fetch lives in
 * `fetchedAtByProvider`, which only the details panel reads.
 */
export function keepUnchangedProviders(
  previous: ProviderRateLimits[] | undefined,
  next: ProviderRateLimits[],
): ProviderRateLimits[] {
  if (!previous) return next;
  const previousById = new Map(
    previous.map((provider) => [provider.provider, provider]),
  );
  let changed = previous.length !== next.length;
  const providers = next.map((provider, index) => {
    const prior = previousById.get(provider.provider);
    if (!prior || !sameProviderUsage(prior, provider)) {
      changed = true;
      return provider;
    }
    if (previous[index] !== prior) changed = true;
    return prior;
  });
  return changed ? providers : previous;
}

interface ProviderRateLimitsState {
  snapshot: ProviderRateLimitSnapshot | null;
  /** When each provider was last fetched, for the "updated … ago" line. */
  fetchedAtByProvider: Record<string, number>;
  isRefreshing: boolean;
  error: string | null;
  usageMode: StatusBarUsageMode;
  emptyCtaDismissed: boolean;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  setUsageMode: (mode: StatusBarUsageMode) => void;
  dismissEmptyCta: () => void;
}

let pollTimer: number | null = null;
let removeVisibilityListener: (() => void) | null = null;
let removeAccountListener: (() => void) | null = null;
let inFlight: Promise<void> | null = null;
let refreshInFlight: Promise<void> | null = null;
/**
 * When the last fetch settled. A window coming back into view fetches at once
 * only when the ticks it skipped while hidden left this more than a poll old.
 */
let lastFetchSettledAt = 0;

function composeUsage(
  previous: ProviderRateLimitSnapshot | null,
  snapshot: ProviderRateLimitSnapshot,
  previousFetchTimes: Record<string, number> = {},
) {
  const merged = mergeStale(previous?.providers, [
    ...snapshot.providers.filter(
      (provider) => !isManagedUsage(provider.provider),
    ),
    ...accountUsage(useProviderAccountsStore.getState()),
  ]);
  const providers = keepUnchangedProviders(previous?.providers, merged);
  return {
    snapshot:
      previous && providers === previous.providers
        ? previous
        : { ...snapshot, providers },
    fetchedAtByProvider: Object.fromEntries(
      merged.map((provider) => [
        provider.provider,
        snapshot === previous && !isManagedUsage(provider.provider)
          ? (previousFetchTimes[provider.provider] ?? provider.updatedAt)
          : provider.updatedAt,
      ]),
    ),
  };
}

export const useProviderRateLimitsStore = create<ProviderRateLimitsState>(
  (set, get) => ({
    snapshot: null,
    fetchedAtByProvider: {},
    isRefreshing: false,
    error: null,
    usageMode: readUsageMode(),
    emptyCtaDismissed: readEmptyCtaDismissed(),

    load: async () => {
      if (inFlight) {
        await inFlight;
        return;
      }
      set({ isRefreshing: true });
      inFlight = (async () => {
        try {
          const snapshot = await getProviderRateLimits();
          set((state) => ({
            ...composeUsage(state.snapshot, snapshot),
            error: null,
          }));
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          lastFetchSettledAt = Date.now();
          set({ isRefreshing: refreshInFlight !== null });
        }
      })().finally(() => {
        inFlight = null;
      });
      await inFlight;
    },

    refresh: async () => {
      if (refreshInFlight) return refreshInFlight;
      set({ isRefreshing: true });
      refreshInFlight = Promise.all([
        get().load(),
        useProviderAccountsStore.getState().refresh(true),
      ])
        .then(() => {
          const previous = get().snapshot;
          set(
            composeUsage(
              previous,
              previous ?? { providers: [], updatedAt: Date.now() },
              get().fetchedAtByProvider,
            ),
          );
        })
        .finally(() => {
          refreshInFlight = null;
          set({ isRefreshing: inFlight !== null });
        });
      await refreshInFlight;
    },

    setUsageMode: (mode) => {
      if (typeof window !== "undefined") {
        getPreferenceStorage()?.setItem(STATUS_BAR_USAGE_MODE_KEY, mode);
      }
      set({ usageMode: mode });
    },

    dismissEmptyCta: () => {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(STATUS_BAR_EMPTY_CTA_DISMISSED_KEY, "1");
      }
      set({ emptyCtaDismissed: true });
    },
  }),
);

export function startProviderRateLimitPolling(): () => void {
  removeAccountListener?.();
  const syncAccounts = () => {
    useProviderRateLimitsStore.setState((state) =>
      composeUsage(
        state.snapshot,
        state.snapshot ?? { providers: [], updatedAt: Date.now() },
        state.fetchedAtByProvider,
      ),
    );
  };
  removeAccountListener = useProviderAccountsStore.subscribe(
    (state, previous) => {
      if (
        state.accounts !== previous.accounts ||
        state.defaults !== previous.defaults ||
        state.statuses !== previous.statuses
      )
        syncAccounts();
    },
  );
  syncAccounts();
  void useProviderRateLimitsStore.getState().load();
  if (pollTimer != null) {
    window.clearInterval(pollTimer);
  }
  removeVisibilityListener?.();
  pollTimer = window.setInterval(() => {
    // Each tick is an HTTP request per provider, and a hidden window has
    // nobody looking at its status bar. Coming back into view catches up.
    if (document.hidden) return;
    void useProviderRateLimitsStore.getState().load();
  }, POLL_MS);
  const handleVisibilityChange = () => {
    if (document.hidden || Date.now() - lastFetchSettledAt < POLL_MS) return;
    void useProviderRateLimitsStore.getState().load();
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);
  removeVisibilityListener = () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };
  return () => {
    if (pollTimer != null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    removeVisibilityListener?.();
    removeVisibilityListener = null;
    removeAccountListener?.();
    removeAccountListener = null;
  };
}
