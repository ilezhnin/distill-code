import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { installRunJournal } from "@/features/conductor/runJournal";
import { hydrateDistillStores } from "@/features/settings/lib/distillStoreHydration";
import { loadPersistedMessageQueues } from "@/features/chat/stores/queuePersistence";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { getCuratedAgentProviders } from "@/features/providers/curatedProviders";
import { getModelCacheRefreshProviderIds } from "@/features/providers/modelCacheRefresh";
import { getProviderCatalog } from "@/features/providers/providerCatalog";
import { personaTargetMigration } from "@/features/agents/lib/personaExecutionTarget";
import { useAgentSetupStore } from "@/features/providers/stores/agentSetupStore";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { useDistroStore } from "@/features/settings/stores/distroStore";
import { getClient, setNotificationHandler } from "@/shared/api/acpConnection";
import notificationHandler from "@/features/chat/acp/acpNotificationHandler";
import { registerChatSessionConfigSnapshotHandlers } from "@/features/chat/acp/sessionConfigSnapshotAdapter";
import { perfLog } from "@/shared/lib/perfLog";
import { prefetchSessionLoadModules } from "@/features/chat/lib/sessionActivation";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";

let startupLatch: Promise<void> | null = null;

/**
 * Startup runs once per window. Both callers can re-invoke while a run is in
 * flight (StrictMode re-mount in dev, the session-window bootstrap effect
 * re-firing on dep churn) or after it succeeded; all of them share the first
 * run. A failed run clears the latch so `useAppStartup`'s `retry()` starts a
 * genuine new attempt.
 */
export function runChatRuntimeStartup(): Promise<void> {
  if (!startupLatch) {
    const attempt = startChatRuntime();
    startupLatch = attempt;
    // Identity guard: a superseded attempt's late rejection must not null out
    // the latch its successor installed.
    attempt.catch(() => {
      if (startupLatch === attempt) {
        startupLatch = null;
      }
    });
  }
  return startupLatch;
}

async function startChatRuntime(
  options: { hydrateMessageQueues?: boolean } = {},
): Promise<void> {
  const tConn = performance.now();
  registerChatSessionConfigSnapshotHandlers();
  setNotificationHandler(notificationHandler);
  // Not awaited: the planner, the memory and the conductor's own state are
  // read from disk, and nothing in the rest of startup depends on them. Each
  // store stays empty and refuses to write until its own read lands (the
  // conductor's three merge instead, so a node created in that window is never
  // dropped), so a slow disk delays those panels rather than the chat.
  void hydrateDistillStores();
  // The run journal (P27) watches the wave and graph stores from here on, so
  // every wave from this point has a trace in the folder. Installed after the
  // hydration call and not before it: the merge that hydration performs is
  // not something a run did, and a journal that opened with it would say the
  // previous session's waves had just been admitted.
  installRunJournal();
  if (options.hydrateMessageQueues !== false) {
    const persistedMessageQueues = await loadPersistedMessageQueues();
    useChatStore.getState().replaceQueuedMessages(persistedMessageQueues);
  }

  // The harness catalog is static. Publish it before waiting on the host so
  // the composer Agent column matches Settings even if the host is slow.
  const store = useAgentStore.getState();
  store.setProviders(getCuratedAgentProviders(), false);

  await getClient();
  perfLog(
    `[perf:startup] ACP getClient ready in ${(performance.now() - tConn).toFixed(1)}ms`,
  );
  // The chat load path's lazy modules are wanted the moment the user opens a
  // chat; warm them now, off the critical path, instead of on that click.
  prefetchSessionLoadModules();

  const modelCacheStore = useProviderModelCacheStore.getState();
  modelCacheStore.loadPersisted();

  // Subscribe to backend-owned agent setup state and rehydrate it once, at the
  // app level, so a card mid-install (or its eventual result) is restored after
  // navigating away or fully reloading the window. Attaching this before any
  // card mounts is what makes reload survival work.
  void useAgentSetupStore
    .getState()
    .init()
    .catch((err) => {
      console.error("Failed to initialize agent setup state on startup:", err);
    });

  const loadDistroBundle = async () => {
    try {
      await useDistroStore.getState().refresh();
    } catch (err) {
      console.error("Failed to load distro bundle on startup:", err);
    }
  };

  const loadRuntimeConfig = async () => {
    const result = await useRuntimeConfigStore.getState().refresh();
    if (result.status !== "ready") {
      console.warn("Runtime config unavailable; using app defaults:", result);
    }
  };

  const loadPersonas = async () => {
    const t0 = performance.now();
    store.setPersonasLoading(true);
    try {
      const { listPersonas } = await import("@/shared/api/agents");
      const personas = await listPersonas();
      store.setPersonas(personas);
      perfLog(
        `[perf:startup] loadPersonas done in ${(performance.now() - t0).toFixed(1)}ms (n=${personas.length})`,
      );
    } catch (err) {
      console.error("Failed to load personas on startup:", err);
    } finally {
      store.setPersonasLoading(false);
    }
  };

  const migratePersonaTargets = async (
    authoritativeProviderIds: ReadonlySet<string>,
  ) => {
    const { migratePersonaTargetIfUnchanged } = await import(
      "@/shared/api/agents"
    );
    const modelState = useProviderModelCacheStore.getState();
    const cachedModels = [...modelState.providers].flatMap(
      ([providerId, entry]) =>
        authoritativeProviderIds.has(providerId)
          ? entry.models.map((model) => ({
              ...model,
              providerId: model.providerId ?? providerId,
            }))
          : [],
    );
    const targetContext = {
      providers: useAgentStore.getState().providers,
      models: cachedModels,
      catalogEntries: getProviderCatalog(),
    };
    const personas = useAgentStore.getState().personas;
    await Promise.all(
      personas.map(async (persona) => {
        if (!persona.writable) return;
        const migration = personaTargetMigration(persona, targetContext);
        if (!migration) return;
        try {
          const migrated = await migratePersonaTargetIfUnchanged(
            persona,
            migration,
          );
          if (migrated) {
            // Do not replace the collection: a refresh or edit may have changed
            // another agent while this idempotent migration write was in flight.
            useAgentStore.getState().updatePersona(persona.id, migrated);
          }
        } catch (error) {
          console.warn("Failed to migrate custom agent target:", {
            personaId: persona.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  };

  const refreshProviderModels = async (): Promise<Set<string>> => {
    const refreshProviderIds = getModelCacheRefreshProviderIds();
    await modelCacheStore.refreshAllModelProviders(refreshProviderIds);
    const modelState = useProviderModelCacheStore.getState();
    return new Set(
      refreshProviderIds.filter((providerId) => {
        const entry = modelState.providers.get(providerId);
        return (
          !entry?.error && modelState.isModelInventoryAuthoritative(providerId)
        );
      }),
    );
  };

  const loadSessionState = async () => {
    const t0 = performance.now();
    perfLog("[perf:startup] loadSessionState start");
    const { loadSessions } = useChatSessionStore.getState();
    await loadSessions();
    perfLog(
      `[perf:startup] loadSessions done in ${(performance.now() - t0).toFixed(1)}ms`,
    );
  };

  await loadRuntimeConfig();
  await loadDistroBundle();
  store.setProviders(getCuratedAgentProviders(), true);

  // Legacy agent-target repair runs off the critical path: the read-time
  // compatibility layer in personaExecutionTarget keeps unmigrated agents
  // working immediately, so startup never waits on inventory for migration.
  const providerModelsReady = refreshProviderModels().catch((err) => {
    console.error("Failed to refresh provider models on startup:", err);
    return new Set<string>();
  });

  await Promise.allSettled([loadPersonas(), loadSessionState()]);
  void providerModelsReady.then((authoritativeProviderIds) =>
    migratePersonaTargets(authoritativeProviderIds).catch((err) => {
      console.error("Failed to migrate custom agent targets:", err);
    }),
  );
}
