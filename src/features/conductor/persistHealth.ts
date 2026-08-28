/**
 * Whether the browser is still accepting what the conductor writes down.
 *
 * The graph, the waves and the telemetry all persist to `localStorage`, and
 * all three swallow a failed write on purpose: a quota error must not take a
 * running wave down with it. The cost of that is the failure mode nobody can
 * see. Past the origin's quota every write silently does nothing, the app
 * keeps rendering the live wave from memory exactly as before, and the next
 * restart comes up with no waves, no children and no explanation — the state
 * stopped being durable hours earlier and nothing said so.
 *
 * This module is the "something said so". It does not change how the stores
 * behave; it only remembers that a write was refused, so the wave engine can
 * tell the operator once and the stats pane can keep showing it.
 *
 * The record lives in memory by design. The one thing that is certainly
 * broken when this fires is persistence, so persisting the fact that
 * persistence is broken would be the least reliable place to put it.
 *
 * The real fix is moving this state into files under `.distill`. This is what
 * makes the interval before that fix visible instead of silent.
 */

import { useSyncExternalStore } from "react";

export type PersistScope = "graph" | "waves" | "telemetry";

export interface PersistHealth {
  /** Failed writes since the app started, per store. */
  failuresByScope: Record<PersistScope, number>;
  /** When the first refusal happened, or `null` while all is well. */
  firstFailureAt: number | null;
  lastFailureAt: number | null;
  /** Best-effort name of the error the browser gave, from the first refusal. */
  reason?: string;
}

const SCOPES: readonly PersistScope[] = ["graph", "waves", "telemetry"];

function emptyHealth(): PersistHealth {
  return {
    failuresByScope: { graph: 0, waves: 0, telemetry: 0 },
    firstFailureAt: null,
    lastFailureAt: null,
  };
}

let health: PersistHealth = emptyHealth();
/** False once the operator has been told. One notice, not one per write. */
let reported = false;
const listeners = new Set<() => void>();

/**
 * Records one refused write.
 *
 * Called from inside a `catch` that must not throw, so this one may not
 * either: everything it touches is a plain object and a Set.
 */
export function notePersistFailure(scope: PersistScope, error?: unknown): void {
  const now = Date.now();
  health = {
    failuresByScope: {
      ...health.failuresByScope,
      [scope]: health.failuresByScope[scope] + 1,
    },
    firstFailureAt: health.firstFailureAt ?? now,
    lastFailureAt: now,
    ...(health.reason
      ? { reason: health.reason }
      : errorName(error)
        ? { reason: errorName(error) }
        : {}),
  };
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A reader that throws must not reach the store's write path.
    }
  }
}

function errorName(error: unknown): string | undefined {
  if (error instanceof Error) {
    // `QuotaExceededError` is the one that matters and the one browsers
    // actually name; anything else is still better than "it failed".
    return error.name || error.message || undefined;
  }
  return undefined;
}

export function getPersistHealth(): PersistHealth {
  return health;
}

export function isPersistHealthy(state: PersistHealth = health): boolean {
  return SCOPES.every((scope) => state.failuresByScope[scope] === 0);
}

export function totalPersistFailures(state: PersistHealth = health): number {
  return SCOPES.reduce((sum, scope) => sum + state.failuresByScope[scope], 0);
}

/** Subscribes to refusals. Returns the unsubscribe. */
export function subscribePersistHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Returns the health once, the first time it is unhealthy, and never again.
 *
 * The engine calls this on every tick. A full origin refuses every write, so
 * reporting per failure would bury the transcript under the same warning
 * hundreds of times — the operator needs to be told, and told once.
 */
export function takeUnreportedPersistFailure(): PersistHealth | null {
  if (reported || isPersistHealthy()) return null;
  reported = true;
  return health;
}

/** Live health for a React reader. Re-renders on every refused write. */
export function usePersistHealth(): PersistHealth {
  return useSyncExternalStore(
    subscribePersistHealth,
    getPersistHealth,
    emptyHealth,
  );
}

export function resetPersistHealthForTests(): void {
  health = emptyHealth();
  reported = false;
  listeners.clear();
}
