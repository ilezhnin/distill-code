import { create } from "zustand";
import * as api from "../api/providerAccounts";
import { useProviderModelCacheStore } from "./providerModelCacheStore";

interface ProviderAccountsState extends api.ProviderAccountsSnapshot {
  statuses: Record<string, api.ProviderAccountStatus>;
  authStates: Record<string, api.ProviderAccountAuthState>;
  loaded: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: (force?: boolean) => Promise<void>;
  add: (input: api.AddProviderAccount) => Promise<api.ProviderAccount>;
  update: (
    id: string,
    patch: Parameters<typeof api.updateProviderAccount>[1],
  ) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setDefault: (providerId: string, accountId: string) => Promise<void>;
  setRouting: (providerId: string, enabled: boolean) => Promise<void>;
  authenticate: (accountId: string, force?: boolean) => Promise<void>;
  signOut: (accountId: string) => Promise<void>;
}

let refreshPromise: Promise<void> | undefined;
let revision = 0;
let forceRefreshQueued = false;

function acceptRegistry(snapshot: api.ProviderAccountsSnapshot) {
  const previous = useProviderAccountsStore.getState().defaults;
  const ids = new Set(snapshot.accounts.map((account) => account.id));
  useProviderAccountsStore.setState((state) => ({
    ...snapshot,
    loaded: true,
    statuses: Object.fromEntries(
      Object.entries(state.statuses).filter(([id]) => ids.has(id)),
    ),
    authStates: Object.fromEntries(
      Object.entries(state.authStates).filter(([id]) => ids.has(id)),
    ),
  }));
  for (const providerId of new Set([
    ...Object.keys(previous),
    ...Object.keys(snapshot.defaults),
  ])) {
    if (previous[providerId] === snapshot.defaults[providerId]) continue;
    const models = useProviderModelCacheStore.getState();
    models.invalidateProvider(providerId, { forget: true });
    void models.refreshProviderModels(providerId, { force: true });
  }
}

function acceptStatuses(snapshot: api.ProviderAccountStatuses) {
  useProviderAccountsStore.setState((state) => {
    const statuses = { ...state.statuses };
    for (const status of snapshot.accounts) {
      if (
        state.loaded &&
        !state.accounts.some((account) => account.id === status.accountId)
      )
        continue;
      if (
        !statuses[status.accountId] ||
        statuses[status.accountId].lastAttemptAt <= status.lastAttemptAt
      ) {
        statuses[status.accountId] = status;
      }
    }
    return { statuses };
  });
}

// This store mirrors backend metadata. Credentials never enter a persisted store.
export const useProviderAccountsStore = create<ProviderAccountsState>(
  (set, get) => ({
    accounts: [],
    defaults: {},
    automaticSwitching: {},
    statuses: {},
    authStates: {},
    loaded: false,
    refreshing: false,
    error: null,
    refresh: (force = false) => {
      if (refreshPromise) {
        forceRefreshQueued ||= force;
        return refreshPromise;
      }
      set({ refreshing: true });
      refreshPromise = (async () => {
        let shouldForce = force;
        do {
          forceRefreshQueued = false;
          const atRevision = revision;
          const attemptedAt = Date.now();
          const [registry, statuses] = await Promise.allSettled([
            api.listProviderAccounts().then((snapshot) => {
              // Local metadata is available immediately, even if a provider
              // takes its full timeout to answer the independent quota probe.
              if (revision === atRevision) acceptRegistry(snapshot);
            }),
            api.getProviderAccountStatuses(shouldForce),
          ]);
          if (statuses.status === "fulfilled") acceptStatuses(statuses.value);
          else {
            set((state) => ({
              statuses: Object.fromEntries(
                Object.entries(state.statuses).map(([id, status]) => [
                  id,
                  status.lastAttemptAt > attemptedAt
                    ? status
                    : {
                        ...status,
                        stale: true,
                        error: String(statuses.reason),
                        lastAttemptAt: attemptedAt,
                      },
                ]),
              ),
            }));
          }
          const failure =
            registry.status === "rejected"
              ? registry.reason
              : statuses.status === "rejected"
                ? statuses.reason
                : null;
          set({ error: failure === null ? null : String(failure) });
          shouldForce = true;
        } while (forceRefreshQueued);
      })().finally(() => {
        refreshPromise = undefined;
        set({ refreshing: false });
      });
      return refreshPromise;
    },
    add: async (input) => {
      const account = await api.addProviderAccount(input);
      revision++;
      set((state) => ({
        accounts: [
          ...state.accounts.filter((entry) => entry.id !== account.id),
          account,
        ],
      }));
      void get().refresh(true);
      return account;
    },
    update: async (id, patch) => {
      const account = await api.updateProviderAccount(id, patch);
      revision++;
      set((state) => ({
        accounts: state.accounts.map((entry) =>
          entry.id === id ? account : entry,
        ),
      }));
      if (patch.apiKey) {
        set((state) => ({
          authStates: {
            ...state.authStates,
            [id]: {
              accountId: id,
              status: "authenticated",
              message: "",
            },
          },
        }));
        useProviderModelCacheStore
          .getState()
          .invalidateProvider(account.providerId, { forget: true });
      }
      void get().refresh(true);
    },
    remove: async (id) => {
      const snapshot = await api.removeProviderAccount(id);
      revision++;
      acceptRegistry(snapshot);
    },
    setDefault: async (providerId, accountId) => {
      const snapshot = await api.setDefaultProviderAccount(
        providerId,
        accountId,
      );
      revision++;
      acceptRegistry(snapshot);
    },
    setRouting: async (providerId, enabled) => {
      const snapshot = await api.setProviderAccountRouting(providerId, enabled);
      revision++;
      acceptRegistry(snapshot);
    },
    authenticate: async (accountId, force = false) => {
      set((state) => ({
        authStates: {
          ...state.authStates,
          [accountId]: { accountId, status: "running", message: "" },
        },
      }));
      try {
        const auth = await api.authenticateProviderAccount(accountId, force);
        set((state) => ({
          authStates: { ...state.authStates, [accountId]: auth },
        }));
      } catch (error) {
        set((state) => ({
          authStates: {
            ...state.authStates,
            [accountId]: { accountId, status: "error", message: String(error) },
          },
        }));
      }
      await get().refresh(true);
    },
    signOut: async (accountId) => {
      await api.signOutProviderAccount(accountId);
      revision++;
      const account = get().accounts.find((entry) => entry.id === accountId);
      const now = Date.now();
      if (account) {
        set((state) => ({
          statuses: {
            ...state.statuses,
            [accountId]: {
              accountId,
              providerId: account.providerId,
              state: "needs_auth",
              accountLabel: state.statuses[accountId]?.accountLabel ?? null,
              subscription: null,
              limits: [],
              resetTokens: null,
              credits: null,
              lastUpdatedAt: now,
              lastAttemptAt: now,
              stale: false,
              error: null,
            },
          },
          authStates: {
            ...state.authStates,
            [accountId]: { accountId, status: "needs_auth", message: "" },
          },
        }));
        useProviderModelCacheStore
          .getState()
          .invalidateProvider(account.providerId, { forget: true });
      }
      void get().refresh(true);
    },
  }),
);

let monitorStarted = false;

export function startProviderAccountsMonitor() {
  if (monitorStarted) return;
  monitorStarted = true;
  const refresh = () => {
    void useProviderAccountsStore.getState().refresh();
  };
  const refreshChanged = () => {
    void useProviderAccountsStore.getState().refresh(true);
  };
  const attach = async () => {
    await Promise.allSettled([
      api.onProviderAccountStatuses(acceptStatuses),
      api.onProviderAccountsChanged(refreshChanged),
      api.onProviderAccountAuthState((auth) => {
        useProviderAccountsStore.setState((state) => ({
          authStates: { ...state.authStates, [auth.accountId]: auth },
        }));
        if (auth.status !== "running") refreshChanged();
      }),
    ]);
    refresh();
  };
  void attach();
  window.setInterval(refresh, 60_000);
  window.addEventListener("focus", refresh);
}
