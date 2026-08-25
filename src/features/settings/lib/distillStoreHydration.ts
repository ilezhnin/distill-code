/**
 * Filling the app's own documents from the Distill folder, once, at startup.
 *
 * Three stores read one file each. They are hydrated together because they
 * share one failure mode: until the read lands, each store is empty and must
 * not write — an empty planner persisted over a full one is a deleted list,
 * and an empty memory is a forgotten one. Doing it in one place makes that
 * window short and obvious rather than three separate races.
 *
 * Failures are logged and swallowed. A folder that cannot be read is a
 * degraded session, not a broken app: the operator keeps working, this run's
 * changes stay in memory, and the next start tries again.
 */

import { hydrateMemoryStore } from "@/features/memory/stores/memoryStore";
import { hydratePlannerStore } from "@/features/planner/stores/plannerStore";
import { hydrateReviewSeenStore } from "@/features/review/stores/reviewSeenStore";

let started = false;

export async function hydrateDistillStores(): Promise<void> {
  if (started) return;
  started = true;
  const results = await Promise.allSettled([
    hydratePlannerStore(),
    hydrateMemoryStore(),
    hydrateReviewSeenStore(),
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
