import { create } from "zustand";
import {
  startProviderAccountsMonitor,
  useProviderAccountsStore,
} from "@/features/providers/stores/providerAccountsStore";
import { getPreferenceStorage } from "@/shared/preferences/rootSettings";
import { accountUsage } from "../lib/accountUsage";
import type {
  ProviderRateLimitSnapshot,
  ProviderRateLimits,
  StatusBarUsageMode,
} from "../lib/rateLimitTypes";
import {
  STATUS_BAR_EMPTY_CTA_DISMISSED_KEY,
  STATUS_BAR_USAGE_MODE_KEY,
} from "../lib/rateLimitTypes";

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

/**
 * Deep equality for the plain data a status read returns, where a missing
 * field and an `undefined` one mean the same thing.
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
 * Whether a provider's usage says what the one already shown says. The read
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
 * The providers' usage, reusing each object already shown whose usage did
 * not change, and the previous array itself when none did.
 *
 * Every poll used to hand subscribers new objects, so the status bar, each
 * `useAgentProviderStatus` consumer and the new-chat session preparation
 * recomputed every minute with nothing to show for it. A kept object keeps
 * the read time it came with; the time of the latest read lives in
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
  /** Every provider's default account as the status bar shows it. */
  snapshot: ProviderRateLimitSnapshot | null;
  /** When each provider's status was last read, for the "updated … ago" line. */
  fetchedAtByProvider: Record<string, number>;
  isRefreshing: boolean;
  error: string | null;
  usageMode: StatusBarUsageMode;
  emptyCtaDismissed: boolean;
  /** Reads every account's status again, reusing a read already in flight. */
  load: () => Promise<void>;
  /** Forces a new status read for every account. */
  refresh: () => Promise<void>;
  setUsageMode: (mode: StatusBarUsageMode) => void;
  dismissEmptyCta: () => void;
}

let removeAccountListener: (() => void) | null = null;
let refreshInFlight: Promise<void> | null = null;

/**
 * The status-bar view of the account model: one entry per provider, its
 * default account's status, whether Flock stores that account or the
 * provider's CLI keeps the one sign-in the model names.
 */
function composeUsage(previous: ProviderRateLimitSnapshot | null) {
  const usage = accountUsage(useProviderAccountsStore.getState());
  const providers = keepUnchangedProviders(previous?.providers, usage);
  return {
    snapshot:
      previous && providers === previous.providers
        ? previous
        : { providers, updatedAt: Date.now() },
    fetchedAtByProvider: Object.fromEntries(
      usage.map((provider) => [provider.provider, provider.updatedAt]),
    ),
  };
}

export const useProviderRateLimitsStore = create<ProviderRateLimitsState>(
  (set) => ({
    snapshot: null,
    fetchedAtByProvider: {},
    isRefreshing: false,
    error: null,
    usageMode: readUsageMode(),
    emptyCtaDismissed: readEmptyCtaDismissed(),

    load: async () => {
      set({ isRefreshing: true });
      try {
        await useProviderAccountsStore.getState().refresh();
        set({ error: useProviderAccountsStore.getState().error });
      } finally {
        set({ isRefreshing: refreshInFlight !== null });
      }
    },

    refresh: async () => {
      if (refreshInFlight) return refreshInFlight;
      set({ isRefreshing: true });
      refreshInFlight = useProviderAccountsStore
        .getState()
        .refresh(true)
        .then(() => {
          set({ error: useProviderAccountsStore.getState().error });
        })
        .finally(() => {
          refreshInFlight = null;
          set({ isRefreshing: false });
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

/**
 * Keeps the status-bar view current: the account monitor polls every
 * account's status (and pauses while the window is hidden), and every
 * change to the accounts, their defaults or statuses recomposes the view.
 */
export function startProviderRateLimitPolling(): () => void {
  removeAccountListener?.();
  const syncAccounts = () => {
    useProviderRateLimitsStore.setState((state) =>
      composeUsage(state.snapshot),
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
  startProviderAccountsMonitor();
  return () => {
    removeAccountListener?.();
    removeAccountListener = null;
  };
}
