import { create } from "zustand";
import { harnessModelLabel } from "../lib/humanizeModelId";
import { formatProviderLabel } from "@/shared/ui/icons/ProviderIcons";
import { claudeModelSortOrder } from "@/features/chat/lib/modelGenerations";
import type { ModelOption } from "@/features/chat/types";
import type {
  ProviderInventoryModel,
  ProviderSupportedModelsResponse,
} from "@/shared/api/hostTypes";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { getClient } from "@/shared/api/acpConnection";
import { notifyProviderModelInventoryInvalidated } from "../lib/providerModelInventoryEvents";

const MODEL_CACHE_STORAGE_KEY = "distill:providerModelCache:v2";
/** Caches under keys this build no longer reads, cleared on the first write. */
const LEGACY_MODEL_CACHE_STORAGE_KEYS = [
  "distill:providerModelCache:v1",
  "goose:providerModelCache:v1",
];
/**
 * Shape of the rows this build caches; the host stamps the same number on
 * every inventory answer.
 *
 * A persisted entry that does not carry it -- written by a build whose rows
 * meant something else -- is dropped on load instead of shown. That is the
 * half of the fix a TTL cannot do: a host-side inventory change (Distill's own
 * extra models, a new probe shape) used to be invisible to a renderer holding
 * a persisted list, for as long as that renderer kept refreshing it in time.
 *
 * 3: rows say where they belong and what they can do (group/order/aliasOf/
 * efforts/defaultEffort/supportsFast/opensOnModel/capabilitySource), and a
 * codex row is a base id rather than one folded with its effort. A v2 entry
 * has none of that, so it is dropped rather than read as a model with no
 * effort menu. Moves with `INVENTORY_SCHEMA_VERSION` in the host's `ext.rs`.
 */
const MODEL_CACHE_SCHEMA_VERSION = 3;
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
/**
 * Floor the model picker passes with its forced open-time refresh.
 *
 * The picker refresh is forced because a cached list that is merely *recent*
 * says nothing about whether it still matches the host's; the floor is what
 * keeps forcing affordable. A burst of picker opens costs one probe, while a
 * changed inventory still reaches the operator within one interaction instead
 * of after a five-minute TTL. Deliberately the same 30s as the failed-poll
 * floor, so a provider whose bridge will not start is probed no more often
 * than it was before the picker started forcing.
 */
export const PICKER_REFRESH_FLOOR_MS = 30 * 1000;
const lastFailedRefreshAt = new Map<string, number>();
const lastRefreshAt = new Map<string, number>();
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
  /**
   * Row shape these models are in -- the host's stamp when it gave one, this
   * build's otherwise. Anything else is discarded on load.
   */
  schemaVersion?: number;
  /**
   * Host inventory generation the last poll reported, as the host spells it.
   * A poll answering with a different one has rebuilt the list, so the entry
   * is rewritten even where an unchanged answer would be left alone.
   */
  revision?: string;
}

interface ProviderModelCacheState {
  providers: Map<string, CachedProviderModels>;
  refreshingProviderIds: Set<string>;
  runtimeManagedProviderIds: Set<string>;
}

export interface RefreshOptions {
  /** Poll even when the cached entry is neither stale nor in error. */
  force?: boolean;
  /**
   * Do not poll this provider again within this many ms of the last poll.
   *
   * Applies to a forced refresh too -- it is the only thing that does -- so a
   * caller that forces on every open (the model picker) can bound the cost
   * without giving up on noticing a changed inventory. Cleared by
   * `bumpRefreshVersion`, because a re-login or a runtime-config reseed is
   * exactly the news the floor was waiting for.
   */
  minIntervalMs?: number;
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
    options?: RefreshOptions,
  ) => Promise<void>;
  refreshAllModelProviders: (
    providerIds: string[],
    options?: RefreshOptions,
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
        .filter(
          (entry) =>
            entry?.providerId &&
            Array.isArray(entry.models) &&
            // Rows of another shape are not shown and not repaired: the host
            // refills the list within one round trip, and the startup refresh
            // is forced precisely so that round trip always happens.
            entry.schemaVersion === MODEL_CACHE_SCHEMA_VERSION,
        )
        .map((entry) => [entry.providerId, entry]),
    );
  } catch {
    return new Map();
  }
}

let legacyCachesDropped = false;

function persistModels(providers: Map<string, CachedProviderModels>): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      MODEL_CACHE_STORAGE_KEY,
      JSON.stringify([...providers.values()]),
    );
    if (!legacyCachesDropped) {
      legacyCachesDropped = true;
      // Regenerable host data under keys nothing reads any more, including the
      // goose-era one this app no longer has a provider for.
      for (const key of LEGACY_MODEL_CACHE_STORAGE_KEYS) {
        window.localStorage.removeItem(key);
      }
    }
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
): Promise<ProviderSupportedModelsResponse> {
  const client = await getClient();
  return await client.host.providersSupportedModelsList({ providerId });
}

/**
 * The shape to cache this answer under: what the host said, or this build's
 * when the host predates the stamp. An unstamped answer is the subset of rows
 * this build already reads; an answer stamped with a version this build does
 * not know is still shown -- it is the only inventory there is -- but it does
 * not survive a restart, because after one nothing here can say how to read it.
 */
function inventorySchemaVersion(
  response: Pick<ProviderSupportedModelsResponse, "schemaVersion">,
): number {
  return response.schemaVersion ?? MODEL_CACHE_SCHEMA_VERSION;
}

/**
 * What the host said this model can do, in the renderer's own spelling.
 *
 * A `null` the host sends means "unknown", which is what an absent field
 * already means here, so nulls are dropped instead of stored. The one value
 * that is never dropped is an EMPTY effort list on a row whose capabilities
 * were actually read: that is an answer -- the model has no effort control --
 * and it must not read like the unasked row, which carries no list at all.
 *
 * A row from a host that says nothing is filed on the main page with its
 * capabilities unknown: presentation must never hide a model its harness
 * advertises, and "nobody asked" is the truth about what it offers.
 */
function inventoryCapabilities(
  entry: ProviderInventoryModel,
): Partial<ModelOption> {
  const capabilitySource = entry.capabilitySource ?? "unknown";
  const efforts = entry.efforts
    ?.filter((effort) => (effort?.value ?? "").trim().length > 0)
    .map((effort) => ({
      id: effort.value,
      name: effort.name?.trim() || effort.value,
    }));
  const statesEfforts =
    efforts != null && (efforts.length > 0 || capabilitySource !== "unknown");
  return {
    group: entry.group ?? "main",
    capabilitySource,
    ...(typeof entry.order === "number" ? { order: entry.order } : {}),
    ...(entry.aliasOf != null ? { aliasOf: entry.aliasOf } : {}),
    ...(statesEfforts ? { efforts } : {}),
    ...(entry.defaultEffort != null
      ? { defaultEffort: entry.defaultEffort }
      : {}),
    ...(entry.supportsFast != null ? { supportsFast: entry.supportsFast } : {}),
    ...(entry.opensOnModel != null ? { opensOnModel: entry.opensOnModel } : {}),
  };
}

function providerModelOptionsFromInventory(
  providerId: string,
  inventory: ProviderInventoryModel[],
): ModelOption[] {
  const providerName = formatProviderLabel(providerId);
  return inventory.map((entry) => {
    const displayName = harnessModelLabel(entry);
    const model: ModelOption = {
      id: entry.id,
      name: displayName,
      displayName,
      providerId,
      providerName,
      // Kept deliberately: outside the picker list this flag still chooses a
      // new chat's default model and tells an explicit selection from a
      // defaulted one.
      recommended: true,
      featured: false,
      ...inventoryCapabilities(entry),
    };
    // The harness's own menu position wins; the Claude-family order is what
    // places a row from a host that files nothing.
    const sortOrder = model.order ?? claudeModelSortOrder(model);
    return sortOrder === undefined ? model : { ...model, sortOrder };
  });
}

export function isCachedModelInventoryAuthoritative(
  entry: CachedProviderModels | undefined,
): boolean {
  return (
    entry != null &&
    (entry.runtimeManaged || (entry.models.length > 0 && entry.fetchedAt > 0))
  );
}

/**
 * Stricter authority, for deciding what a session may be *started* on.
 *
 * A refresh that threw keeps the previous payload with its `fetchedAt` — that
 * is deliberate, so the picker can still show yesterday's list rather than
 * going blank on a transient failure. But routing is not display: the only
 * signal the crew ranking has for "is this harness usable right now" is this
 * cache, and a bridge that failed to start is exactly the case where the last
 * good list is a lie. Answering "we do not know" instead demotes the platform
 * in the ranking (an empty list reads as not installed) and the step runs
 * somewhere that works, rather than four steps dying one after another on the
 * same broken bridge with no retry (Q2).
 *
 * Runtime-managed entries are exempt: their models come from the app's own
 * config rather than from a poll, so there is no failed poll to distrust.
 */
export function isCachedModelInventoryAuthoritativeForRouting(
  entry: CachedProviderModels | undefined,
): boolean {
  if (!isCachedModelInventoryAuthoritative(entry)) return false;
  if (entry?.runtimeManaged) return true;
  return !entry?.error && entry?.outcome !== "failed";
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
  // runtime config), so the previous poll -- failed or not -- says nothing
  // about the next one.
  lastFailedRefreshAt.delete(providerId);
  lastRefreshAt.delete(providerId);
  notifyProviderModelInventoryInvalidated(providerId);
}

function isWithinFailedRefreshFloor(providerId: string): boolean {
  const lastFailure = lastFailedRefreshAt.get(providerId);
  return (
    lastFailure != null &&
    Date.now() - lastFailure < FAILED_REFRESH_RETRY_FLOOR_MS
  );
}

function isWithinRefreshFloor(providerId: string, floorMs: number): boolean {
  const lastRefresh = lastRefreshAt.get(providerId);
  return lastRefresh != null && Date.now() - lastRefresh < floorMs;
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
            schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
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
      // The only floor a forced refresh observes; see PICKER_REFRESH_FLOOR_MS.
      if (
        options.minIntervalMs != null &&
        isWithinRefreshFloor(providerId, options.minIntervalMs)
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
      lastRefreshAt.set(providerId, Date.now());
      const refresh = (async () => {
        set((state) => {
          const refreshingProviderIds = new Set(state.refreshingProviderIds);
          refreshingProviderIds.add(providerId);
          return { refreshingProviderIds };
        });

        try {
          const response = await fetchProviderSupportedModels(providerId);
          const schemaVersion = inventorySchemaVersion(response);
          // A host that rebuilt its inventory answers with a new revision. The
          // rows we hold then describe a generation that is gone, so they are
          // rewritten even where an unchanged answer would be left alone.
          const revisionChanged =
            existing?.revision != null &&
            response.revision != null &&
            existing.revision !== response.revision;
          const discoveredModels = providerModelOptionsFromInventory(
            providerId,
            response.models,
          );
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
              !existing.error &&
              !revisionChanged
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
              // The rows kept here are the previous ones, so they keep the
              // shape they were written in; the revision advances, because it
              // records the newest generation this entry has been told about.
              schemaVersion:
                existing?.schemaVersion ?? MODEL_CACHE_SCHEMA_VERSION,
              ...(response.revision != null
                ? { revision: response.revision }
                : {}),
              ...(existing?.configuredModels
                ? { configuredModels: existing.configuredModels }
                : {}),
              outcome: "empty",
            };
            // Only a refresh that actually drops a usable payload invalidates
            // downstream inventory. Recording the outcome on an entry that was
            // already a non-answer, or on a provider with no entry at all, must
            // not fire that event: it did not fire before, and every listener
            // treats it as "the list you were holding is gone" -- which is
            // also exactly what a changed revision means, whatever the entry
            // was holding before.
            if (
              existing &&
              (revisionChanged ||
                !(existing.fetchedAt === 0 && !existing.error))
            ) {
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
            schemaVersion,
            ...(response.revision != null
              ? { revision: response.revision }
              : {}),
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
              // Nothing was learned about the inventory, so the entry keeps
              // whatever generation and shape its rows already carried.
              schemaVersion:
                existing?.schemaVersion ?? MODEL_CACHE_SCHEMA_VERSION,
              ...(existing?.revision != null
                ? { revision: existing.revision }
                : {}),
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
            // Kept with the models they describe: the list is retained, so
            // what shape and generation it is stays true of it.
            schemaVersion: existing.schemaVersion ?? MODEL_CACHE_SCHEMA_VERSION,
            ...(existing.revision != null
              ? { revision: existing.revision }
              : {}),
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
