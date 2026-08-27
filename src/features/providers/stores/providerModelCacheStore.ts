import { create } from "zustand";
import { providerModelOptionsFromIds } from "../lib/modelRecommendations";
import type { ModelOption } from "@/features/chat/types";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { getClient } from "@/shared/api/acpConnection";
import { notifyProviderModelInventoryInvalidated } from "../lib/providerModelInventoryEvents";

const MODEL_CACHE_STORAGE_KEY = "goose:providerModelCache:v1";
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
/**
 * Floor on how soon a provider whose last poll *failed* may be polled again.
 *
 * `isStale` calls any entry carrying an `error` stale, so a failing provider is
 * re-polled every single time the model picker opens. On the goose side that is
 * not a cheap request: `on_list_provider_supported_models` calls
 * `create_provider(..., true)`, which starts a fresh ACP bridge child process
 * for the very providers most likely to be in an error state.
 *
 * Thirty seconds is picked so that a burst of picker opens costs one probe
 * instead of one each, while a provider repaired outside the app still comes
 * back on its own within one interaction. Anything that knows the situation
 * changed skips the floor rather than waiting it out: an explicit `force`
 * refresh (which every manual/after-setup entry point already uses), and
 * `bumpRefreshVersion`, which fires on re-login and on a runtime-config reseed.
 *
 * Successful and empty answers are deliberately not floored -- a success is
 * already bounded by MODEL_CACHE_TTL_MS, and an empty answer keeps its
 * immediate-retry contract. Concurrency needs nothing extra here: a second
 * caller joins the promise in `inFlightRefreshes`, so a provider never has two
 * polls in flight at once.
 */
const FAILED_REFRESH_RETRY_FLOOR_MS = 30 * 1000;
const lastFailedRefreshAt = new Map<string, number>();
const inFlightRefreshes = new Map<string, Promise<void>>();
const queuedForceRefreshes = new Map<string, Promise<void>>();
const providerRefreshVersions = new Map<string, number>();

/**
 * What the last poll of this provider's model list actually said.
 *
 * Goose answers in three distinct ways -- `fetch_supported_models` returns
 * `Err(RequestFailed(...))` when the agent never produced a model config, an
 * empty vector when it answered with no models, and a populated one otherwise
 * -- and all three used to arrive here as the same empty list, so the operator
 * could not tell a bridge that never came up from a provider that genuinely
 * serves nothing.
 *
 * This field is recorded for display only. Nothing about which models reach
 * consumers, or when a refresh retries, reads it.
 */
export type ProviderModelFetchOutcome = "models" | "empty" | "failed";

export interface CachedProviderModels {
  providerId: string;
  models: ModelOption[];
  fetchedAt: number;
  runtimeManaged?: boolean;
  configuredModels?: ModelOption[];
  error?: string;
  /** Outcome of the last poll; absent on entries seeded from runtime config. */
  outcome?: ProviderModelFetchOutcome;
}

interface ProviderModelCacheState {
  providers: Map<string, CachedProviderModels>;
  refreshingProviderIds: Set<string>;
  runtimeManagedProviderIds: Set<string>;
}

interface ProviderModelCacheActions {
  loadPersisted: () => void;
  seedRuntimeModels: (
    modelsByProviderId: Map<string, ModelOption[]>,
    options?: { fresh?: boolean; runtimeManagedProviderIds?: Set<string> },
  ) => void;
  getModelsForProvider: (providerId: string) => ModelOption[];
  isModelInventoryAuthoritative: (providerId: string) => boolean;
  getError: (providerId: string) => string | null;
  refreshProviderModels: (
    providerId: string,
    options?: { force?: boolean },
  ) => Promise<void>;
  refreshAllModelProviders: (
    providerIds: string[],
    options?: { force?: boolean },
  ) => Promise<void>;
  invalidateProvider: (
    providerId: string,
    options?: { forget?: boolean },
  ) => void;
}

export type ProviderModelCacheStore = ProviderModelCacheState &
  ProviderModelCacheActions;

function readPersistedModels(): Map<string, CachedProviderModels> {
  if (typeof window === "undefined") {
    return new Map();
  }

  try {
    const raw = window.localStorage.getItem(MODEL_CACHE_STORAGE_KEY);
    if (!raw) {
      return new Map();
    }
    const parsed = JSON.parse(raw) as CachedProviderModels[];
    if (!Array.isArray(parsed)) {
      return new Map();
    }
    return new Map(
      parsed
        .filter((entry) => entry?.providerId && Array.isArray(entry.models))
        .map((entry) => [entry.providerId, entry]),
    );
  } catch {
    return new Map();
  }
}

function persistModels(providers: Map<string, CachedProviderModels>): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      MODEL_CACHE_STORAGE_KEY,
      JSON.stringify([...providers.values()]),
    );
  } catch {
    // localStorage may be unavailable.
  }
}

function runtimeManagedProviderIdsFrom(
  providers: Map<string, CachedProviderModels>,
): Set<string> {
  return new Set(
    [...providers.values()]
      .filter((entry) => entry.runtimeManaged)
      .map((entry) => entry.providerId),
  );
}

function readPersistedProviderState(): Pick<
  ProviderModelCacheState,
  "providers" | "runtimeManagedProviderIds"
> {
  const providers = readPersistedModels();
  return {
    providers,
    runtimeManagedProviderIds: runtimeManagedProviderIdsFrom(providers),
  };
}

async function fetchProviderSupportedModels(
  providerId: string,
): Promise<string[]> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableProvidersSupportedModelsList(
    {
      providerId,
    },
  );
  return response.models;
}

export function isCachedModelInventoryAuthoritative(
  entry: CachedProviderModels | undefined,
): boolean {
  return (
    entry != null &&
    (entry.runtimeManaged || (entry.models.length > 0 && entry.fetchedAt > 0))
  );
}

function isStale(entry: CachedProviderModels | undefined): boolean {
  if (!entry || entry.error || !isCachedModelInventoryAuthoritative(entry)) {
    return true;
  }
  return (
    !entry.runtimeManaged && Date.now() - entry.fetchedAt > MODEL_CACHE_TTL_MS
  );
}

function refreshVersion(providerId: string): number {
  return providerRefreshVersions.get(providerId) ?? 0;
}

function bumpRefreshVersion(providerId: string): void {
  providerRefreshVersions.set(providerId, refreshVersion(providerId) + 1);
  // The caller knows something changed for this provider (new credentials, new
  // runtime config), so the previous failure says nothing about the next poll.
  lastFailedRefreshAt.delete(providerId);
  notifyProviderModelInventoryInvalidated(providerId);
}

function isWithinFailedRefreshFloor(providerId: string): boolean {
  const lastFailure = lastFailedRefreshAt.get(providerId);
  return (
    lastFailure != null &&
    Date.now() - lastFailure < FAILED_REFRESH_RETRY_FLOOR_MS
  );
}

export const useProviderModelCacheStore = create<ProviderModelCacheStore>(
  (set, get) => ({
    ...readPersistedProviderState(),
    refreshingProviderIds: new Set(),

    loadPersisted: () => {
      set(readPersistedProviderState());
    },

    seedRuntimeModels: (modelsByProviderId, options = {}) => {
      set((state) => {
        const providers = new Map(state.providers);
        const nextRuntimeManagedProviderIds = new Set(
          state.runtimeManagedProviderIds,
        );
        const runtimeProviderIds = new Set(modelsByProviderId.keys());
        const runtimeManagedProviderIds =
          options.runtimeManagedProviderIds ?? runtimeProviderIds;

        for (const providerId of runtimeProviderIds) {
          bumpRefreshVersion(providerId);
          const models = modelsByProviderId.get(providerId) ?? [];
          const runtimeManaged = runtimeManagedProviderIds.has(providerId);
          providers.set(providerId, {
            providerId,
            models,
            fetchedAt: runtimeManaged || options.fresh ? Date.now() : 0,
            ...(runtimeManaged
              ? { runtimeManaged }
              : { configuredModels: models }),
          });
          if (runtimeManaged) {
            nextRuntimeManagedProviderIds.add(providerId);
          } else {
            nextRuntimeManagedProviderIds.delete(providerId);
          }
        }

        for (const providerId of [...nextRuntimeManagedProviderIds]) {
          if (!runtimeProviderIds.has(providerId)) {
            bumpRefreshVersion(providerId);
            nextRuntimeManagedProviderIds.delete(providerId);
            providers.delete(providerId);
          }
        }

        persistModels(providers);
        return {
          providers,
          runtimeManagedProviderIds: nextRuntimeManagedProviderIds,
        };
      });
    },

    getModelsForProvider: (providerId) =>
      get().providers.get(providerId)?.models ?? [],

    isModelInventoryAuthoritative: (providerId) =>
      isCachedModelInventoryAuthoritative(get().providers.get(providerId)),

    getError: (providerId) => get().providers.get(providerId)?.error ?? null,

    refreshProviderModels: async (providerId, options = {}) => {
      const current = get();
      const existing = current.providers.get(providerId);
      if (
        existing?.runtimeManaged ||
        current.runtimeManagedProviderIds.has(providerId)
      ) {
        return;
      }
      if (!options.force && !isStale(existing)) {
        return;
      }
      // Only an entry that failed is floored; see FAILED_REFRESH_RETRY_FLOOR_MS.
      if (
        !options.force &&
        existing?.error &&
        isWithinFailedRefreshFloor(providerId)
      ) {
        return;
      }

      if (options.force) {
        notifyProviderModelInventoryInvalidated(providerId);
      }

      const inFlightRefresh = inFlightRefreshes.get(providerId);
      if (inFlightRefresh) {
        if (!options.force) {
          await inFlightRefresh;
          return;
        }

        const queuedRefresh = queuedForceRefreshes.get(providerId);
        if (queuedRefresh) {
          await queuedRefresh;
          return;
        }

        const forceRefresh = inFlightRefresh
          .catch(() => undefined)
          .then(() => get().refreshProviderModels(providerId, { force: true }))
          .finally(() => {
            queuedForceRefreshes.delete(providerId);
          });
        queuedForceRefreshes.set(providerId, forceRefresh);
        await forceRefresh;
        return;
      }

      const versionAtStart = refreshVersion(providerId);
      const refresh = (async () => {
        set((state) => {
          const refreshingProviderIds = new Set(state.refreshingProviderIds);
          refreshingProviderIds.add(providerId);
          return { refreshingProviderIds };
        });

        try {
          const ids = await fetchProviderSupportedModels(providerId);
          const discoveredModels = providerModelOptionsFromIds(providerId, ids);
          if (discoveredModels.length === 0) {
            if (versionAtStart !== refreshVersion(providerId)) {
              return;
            }
            // Already recorded as a non-answer: nothing to write, exactly as
            // before this outcome existed. Only the transition into the state
            // touches the store, so a provider that keeps answering nothing
            // does not re-render its consumers on every poll.
            if (
              existing?.outcome === "empty" &&
              existing.fetchedAt === 0 &&
              !existing.error
            ) {
              return;
            }
            // The agent answered and named nothing. What consumers read back is
            // unchanged -- the previous payload stays as a retryable non-answer
            // with fetchedAt 0 -- but the entry now says *why* it is empty, so
            // the picker can report "no models" instead of showing the same
            // blank list a failed poll produces.
            const retryableEntry: CachedProviderModels = {
              providerId,
              models: existing?.models ?? [],
              fetchedAt: 0,
              ...(existing?.configuredModels
                ? { configuredModels: existing.configuredModels }
                : {}),
              outcome: "empty",
            };
            // Only a refresh that actually drops a usable payload invalidates
            // downstream inventory. Recording the outcome on an entry that was
            // already a non-answer, or on a provider with no entry at all, must
            // not fire that event: it did not fire before, and every listener
            // treats it as "the list you were holding is gone".
            if (existing && !(existing.fetchedAt === 0 && !existing.error)) {
              notifyProviderModelInventoryInvalidated(providerId);
            }
            set((state) => {
              const providers = new Map(state.providers);
              providers.set(providerId, retryableEntry);
              persistModels(providers);
              return { providers };
            });
            return;
          }
          const configuredModels = existing?.configuredModels ?? [];
          const configuredModelsById = new Map(
            configuredModels.map((model) => [model.id, model]),
          );
          const hasConfiguredFeaturedModel = configuredModels.some(
            (model) => model.featured,
          );
          const discoveredModelIds = new Set(
            discoveredModels.map((model) => model.id),
          );
          const models = [
            ...discoveredModels.map((model) => ({
              ...model,
              ...(hasConfiguredFeaturedModel ? { featured: false } : {}),
              ...configuredModelsById.get(model.id),
            })),
            ...configuredModels.filter(
              (model) => !discoveredModelIds.has(model.id),
            ),
          ];
          const entry: CachedProviderModels = {
            providerId,
            models,
            fetchedAt: Date.now(),
            ...(configuredModels.length > 0 ? { configuredModels } : {}),
            outcome: "models",
          };
          if (versionAtStart !== refreshVersion(providerId)) {
            return;
          }
          notifyProviderModelInventoryInvalidated(providerId);
          set((state) => {
            const providers = new Map(state.providers);
            providers.set(providerId, entry);
            persistModels(providers);
            return { providers };
          });
        } catch (error) {
          if (versionAtStart !== refreshVersion(providerId)) {
            return;
          }
          lastFailedRefreshAt.set(providerId, Date.now());
          set((state) => {
            const providers = new Map(state.providers);
            providers.set(providerId, {
              providerId,
              models: existing?.models ?? [],
              fetchedAt: existing?.fetchedAt ?? 0,
              ...(existing?.configuredModels
                ? { configuredModels: existing.configuredModels }
                : {}),
              error: formatAcpErrorMessage(error),
              outcome: "failed",
            });
            persistModels(providers);
            return { providers };
          });
        } finally {
          set((state) => {
            const refreshingProviderIds = new Set(state.refreshingProviderIds);
            refreshingProviderIds.delete(providerId);
            return { refreshingProviderIds };
          });
        }
      })();

      inFlightRefreshes.set(providerId, refresh);
      try {
        await refresh;
      } finally {
        inFlightRefreshes.delete(providerId);
      }
    },

    refreshAllModelProviders: async (providerIds, options = {}) => {
      await Promise.allSettled(
        providerIds.map((providerId) =>
          get().refreshProviderModels(providerId, options),
        ),
      );
    },

    /**
     * Mark a provider's model list as needing a fresh poll.
     *
     * `forget: true` additionally drops the list. Use it only when the
     * provider itself is gone or has become a different backend -- a deleted
     * credential, a deleted or re-pointed custom provider -- where the list we
     * hold may describe something that no longer exists.
     *
     * The default keeps the list, because the common caller is a re-login and
     * a re-login means "this may be out of date", not "there is nothing". The
     * `cli_auth` ACP providers (codex-acp, grok-acp, claude-acp) route every
     * sign-in through here, and deleting on each one wiped their whole model
     * list until a poll succeeded -- with a bridge that would not start, it
     * never came back.
     */
    invalidateProvider: (providerId, options = {}) => {
      bumpRefreshVersion(providerId);
      set((state) => {
        if (state.runtimeManagedProviderIds.has(providerId)) {
          const existing = state.providers.get(providerId);
          if (!existing || existing.runtimeManaged) {
            return {};
          }
          const providers = new Map(state.providers);
          providers.set(providerId, { ...existing, runtimeManaged: true });
          persistModels(providers);
          return { providers };
        }
        const existing = state.providers.get(providerId);
        if (!existing) {
          return {};
        }
        const providers = new Map(state.providers);
        if (options.forget) {
          providers.delete(providerId);
        } else {
          // `fetchedAt: 0` is the store's existing spelling of "retryable
          // non-answer": `isCachedModelInventoryAuthoritative` rejects it and
          // `isStale` re-polls it, so nothing downstream treats the retained
          // list as fact -- the picker just has something to show meanwhile.
          //
          // `outcome` is kept as-is: it still describes the last poll, which
          // is the only poll that happened. Inventing one here would report a
          // provider answer that was never given.
          //
          // `error` is dropped: it described the previous credentials and must
          // not outlive them. That also keeps `getError` behaving exactly as
          // the old delete did.
          //
          // `runtimeManaged` is dropped for the same reason the old delete
          // dropped it: this branch is the non-runtime-managed path, and an
          // entry that kept the flag would stay authoritative forever.
          providers.set(providerId, {
            providerId,
            models: existing.models,
            fetchedAt: 0,
            ...(existing.configuredModels
              ? { configuredModels: existing.configuredModels }
              : {}),
            ...(existing.outcome ? { outcome: existing.outcome } : {}),
          });
        }
        persistModels(providers);
        return { providers };
      });
    },
  }),
);
