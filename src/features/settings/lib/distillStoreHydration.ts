/**
 * Filling the app's own documents from the Distill folder, once, at startup.
 *
 * Seven stores read one file each. They are hydrated together because they
 * share one failure mode: until the read lands, each store is empty and must
 * not write — an empty planner persisted over a full one is a deleted list,
 * and an empty memory is a forgotten one. Doing it in one place makes that
 * window short and obvious rather than three separate races.
 *
 * Failures are logged and swallowed. A folder that cannot be read is a
 * degraded session, not a broken app: the operator keeps working, this run's
 * changes stay in memory, and the next start tries again.
 */

import {
  flushRoutingPolicyWrites,
  hydrateRoutingPolicyStore,
} from "@/features/agents/stores/routingPolicyStore";
import {
  flushConductorGraphWrites,
  hydrateConductorGraph,
  markConductorGraphHydrationFailed,
} from "@/features/conductor/conductorGraphStore";
import {
  flushWaveEngineWrites,
  hydrateWaveEngineState,
  markWaveEngineStateHydrationFailed,
} from "@/features/conductor/waveStore";
import {
  flushWaveTelemetryWrites,
  hydrateWaveTelemetry,
  markWaveTelemetryHydrationFailed,
} from "@/features/conductor/waveTelemetryStore";
import {
  flushMemoryWrites,
  hydrateMemoryStore,
} from "@/features/memory/stores/memoryStore";
import {
  flushPlannerWrites,
  hydratePlannerStore,
} from "@/features/planner/stores/plannerStore";
import {
  flushReviewSeenWrites,
  hydrateReviewSeenStore,
} from "@/features/review/stores/reviewSeenStore";

let started = false;

/**
 * How many times a conductor document read is attempted before the store is
 * told to give up, and the pauses between attempts.
 *
 * The conductor's three documents are the only copy of every past executor,
 * report and tombstone, and a read that fails is most often a file briefly
 * held by something else — an antivirus pass, a sync client — at the moment
 * the app starts. Three tries over a few seconds ride that out; a folder
 * still unreadable after them is a session the wave engine sits out.
 */
export const CONDUCTOR_HYDRATION_ATTEMPTS = 3;
export const CONDUCTOR_HYDRATION_RETRY_DELAYS_MS: readonly number[] = [
  500, 2_000,
];

let delayForTests: ((ms: number) => Promise<void>) | null = null;

function pause(ms: number): Promise<void> {
  if (delayForTests) return delayForTests(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads one conductor document, retrying a rejected read with backoff, and
 * tells the store to stop waiting when the last attempt fails too.
 *
 * The store stays unhydrated — and refuses to write — throughout, so a read
 * that fails every time costs this session the engine and nothing on disk.
 * Resolves either way; the failure is logged where the flush failures are.
 */
async function hydrateConductorDocument(
  name: string,
  hydrate: () => Promise<void>,
  giveUp: () => void,
): Promise<void> {
  for (let attempt = 1; attempt <= CONDUCTOR_HYDRATION_ATTEMPTS; attempt += 1) {
    try {
      await hydrate();
      return;
    } catch (error) {
      console.error(
        `Failed to load ${name} (attempt ${attempt} of ${CONDUCTOR_HYDRATION_ATTEMPTS}):`,
        error,
      );
      if (attempt === CONDUCTOR_HYDRATION_ATTEMPTS) break;
      const delay =
        CONDUCTOR_HYDRATION_RETRY_DELAYS_MS[
          Math.min(attempt - 1, CONDUCTOR_HYDRATION_RETRY_DELAYS_MS.length - 1)
        ] ?? 0;
      await pause(delay);
    }
  }
  giveUp();
}

export async function hydrateDistillStores(): Promise<void> {
  if (started) return;
  started = true;
  installDistillStoreCloseFlush();
  const results = await Promise.allSettled([
    hydratePlannerStore(),
    hydrateMemoryStore(),
    hydrateReviewSeenStore(),
    // The conductor's three (P24). They merge rather than replace, so a node
    // or a wave created between module init and this read is never dropped —
    // see `conductorDocuments.ts` for why that ordering is the design. Each
    // is retried on a failed read, and told when the retries are spent, so
    // whatever waits on it (the wave engine, above all) is never parked for
    // the rest of the session.
    hydrateConductorDocument(
      "conductor/graph.json",
      hydrateConductorGraph,
      markConductorGraphHydrationFailed,
    ),
    hydrateConductorDocument(
      "conductor/waves.json",
      hydrateWaveEngineState,
      markWaveEngineStateHydrationFailed,
    ),
    hydrateConductorDocument(
      "conductor/telemetry.json",
      hydrateWaveTelemetry,
      markWaveTelemetryHydrationFailed,
    ),
    // The routing policy (P36-P38). Read early because it decides which model
    // a session starts on, and a session started before it lands would use the
    // shipped defaults rather than the operator's thresholds.
    hydrateRoutingPolicyStore(),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("Failed to load a Distill document:", result.reason);
    }
  }
}

/** Test seam: lets a case run the hydration again. */
export function resetDistillHydrationForTests(): void {
  started = false;
}

/** Test seam: replaces the retry pause, or (`null`) restores the timer. */
export function setDistillHydrationDelayForTests(
  delay: ((ms: number) => Promise<void>) | null,
): void {
  delayForTests = delay;
}

/**
 * Pushes every store's queued write to disk, without waiting.
 *
 * Each document debounces its writes by `DISTILL_WRITE_DEBOUNCE_MS`, so there
 * is always a window in which a remembered fact or a ticked task exists only
 * in the renderer. Killing the app inside that window forgot it. The flush
 * functions exist ("for tests and for shutdown") but nothing outside tests
 * called them until now.
 *
 * Fire-and-forget is enough here, for the same reason the telemetry close
 * flush is (see `installCloseFlushHooks` in `shared/telemetry/client.ts`):
 * `writeDistillDocument` is a Tauri `invoke`, and once the IPC message crosses
 * into the Rust process the write runs on the native runtime, which outlives
 * the webview. The durable step is posting the message, not awaiting the
 * answer — and posting is all an unload handler gets to do anyway. Nothing in
 * an unload path may throw, so each flush is contained.
 */
export function flushDistillStores(): void {
  const flushes = [
    flushPlannerWrites,
    flushMemoryWrites,
    flushReviewSeenWrites,
    flushConductorGraphWrites,
    flushWaveEngineWrites,
    flushWaveTelemetryWrites,
    flushRoutingPolicyWrites,
  ];
  for (const flush of flushes) {
    try {
      void flush().catch((error: unknown) => {
        console.error("Failed to flush a Distill document:", error);
      });
    } catch (error) {
      console.error("Failed to flush a Distill document:", error);
    }
  }
}

let closeFlushInstalled = false;

/**
 * Flushes on the same two teardown signals the telemetry pipeline watches
 * (see `attach_main_window_lifecycle` in `src-tauri/src/lib.rs`): the main
 * window's close is turned into `hide()` while a secondary window exists,
 * which is a `visibilitychange` to hidden with the page surviving, while a
 * last-window close, a detached session window close, and app quit are real
 * webview destructions, which is `pagehide`. Flushing on every hide is safe —
 * a flush with nothing pending is a no-op — and covers the app being killed
 * while backgrounded.
 *
 * Installed from `hydrateDistillStores` so it exists in every window that
 * hydrates these stores, guarded by its own flag because the hydration latch
 * has a test-only reset.
 */
function installDistillStoreCloseFlush(): void {
  if (closeFlushInstalled) return;
  closeFlushInstalled = true;
  try {
    window.addEventListener("pagehide", () => flushDistillStores());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushDistillStores();
    });
  } catch (error) {
    console.error("Failed to install the Distill document close flush:", error);
  }
}
