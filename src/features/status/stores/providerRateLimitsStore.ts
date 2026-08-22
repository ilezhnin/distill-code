import { create } from "zustand";
import { getProviderRateLimits } from "../api/providerRateLimits";
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
  return window.localStorage.getItem(STATUS_BAR_USAGE_MODE_KEY) === "compact"
    ? "compact"
    : "verbose";
}

function readEmptyCtaDismissed(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.localStorage.getItem(STATUS_BAR_EMPTY_CTA_DISMISSED_KEY) === "1"
  );
}

function mergeStale(
  previous: ProviderRateLimits[] | undefined,
  next: ProviderRateLimits[],
): ProviderRateLimits[] {
  if (!previous) return next;
  const previousById = new Map(
    previous.map((provider) => [provider.provider, provider]),
  );
  return next.map((provider) => {
    const prior = previousById.get(provider.provider);
    if (!prior || !hasUsageData(prior)) return provider;
    if (hasUsageData(provider) || provider.status === "ok") return provider;
    return {
      ...provider,
      session: provider.session ?? prior.session,
      weekly: provider.weekly ?? prior.weekly,
      fableWeekly: provider.fableWeekly ?? prior.fableWeekly,
      monthly: provider.monthly ?? prior.monthly,
      accountLabel: provider.accountLabel ?? prior.accountLabel,
      planType: provider.planType ?? prior.planType,
      error: provider.error ?? prior.error,
    };
  });
}

interface ProviderRateLimitsState {
  snapshot: ProviderRateLimitSnapshot | null;
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
let inFlight: Promise<void> | null = null;

export const useProviderRateLimitsStore = create<ProviderRateLimitsState>(
  (set, get) => ({
    snapshot: null,
    isRefreshing: false,
    error: null,
    usageMode: readUsageMode(),
    emptyCtaDismissed: readEmptyCtaDismissed(),

    load: async () => {
      if (inFlight) {
        await inFlight;
        return;
      }
      inFlight = get()
        .refresh()
        .finally(() => {
          inFlight = null;
        });
      await inFlight;
    },

    refresh: async () => {
      set({ isRefreshing: true });
      try {
        const snapshot = await getProviderRateLimits();
        set((state) => ({
          snapshot: {
            ...snapshot,
            providers: mergeStale(
              state.snapshot?.providers,
              snapshot.providers,
            ),
          },
          error: null,
          isRefreshing: false,
        }));
      } catch (error) {
        set({
          isRefreshing: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    setUsageMode: (mode) => {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(STATUS_BAR_USAGE_MODE_KEY, mode);
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
  void useProviderRateLimitsStore.getState().load();
  if (pollTimer != null) {
    window.clearInterval(pollTimer);
  }
  pollTimer = window.setInterval(() => {
    void useProviderRateLimitsStore.getState().refresh();
  }, POLL_MS);
  return () => {
    if (pollTimer != null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  };
}
