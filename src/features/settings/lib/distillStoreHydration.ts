/**
 * Filling the app's own documents from the Distill folder, once, at startup.
 *
 * Six stores read one file each. They are hydrated together because they
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
  flushConductorGraphWrites,
  hydrateConductorGraph,
} from "@/features/conductor/conductorGraphStore";
import {
  flushWaveEngineWrites,
  hydrateWaveEngineState,
} from "@/features/conductor/waveStore";
import {
  flushWaveTelemetryWrites,
  hydrateWaveTelemetry,
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
    // see `conductorDocuments.ts` for why that ordering is the design.
    hydrateConductorGraph(),
    hydrateWaveEngineState(),
    hydrateWaveTelemetry(),
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
