/**
 * The poke: "what's the status?", asked by the operator instead of by hand.
 *
 * Deferred from 1d for a concrete reason — until the wave engine shipped, any
 * message into a conductor chat was intercepted by `useConductorAutoSpawn` and
 * started a *second* brigade. That hook is gone, so a poke is now just a user
 * message like any other, and it goes through the same cross-session envelope
 * everything else in this feature uses: a real turn in the transcript, visibly
 * marked, never a hidden nudge.
 *
 * What it sends is `WAVE_POKE_PROMPT`, and only to the waiting session itself —
 * never to the children. The children are working; interrupting them is what
 * the operator is trying to avoid by asking the parent instead.
 *
 * Spam control is a process-local in-flight set rather than component state:
 * the indicator hosting the button remounts freely, and a disabled prop that
 * forgets across a remount is not a guard. Subscribers are notified so the
 * button re-renders disabled after a remount mid-flight.
 */

import { deliverEnvelope } from "./digestDelivery";
import { WAVE_POKE_PROMPT } from "./wavePrompts";

const inFlight = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** True while a poke for this session has been sent but has not settled. */
export function isPokeInFlight(sessionId: string): boolean {
  return inFlight.has(sessionId);
}

/** Subscribes to in-flight changes. Returns the unsubscribe. */
export function subscribeToPokeState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Asks a waiting session for an interim summary.
 *
 * A no-op while one is already in flight for that session, so a double-click
 * cannot produce two turns. Never throws: a failed poke leaves the button
 * enabled again and the operator can retry, which is the whole recovery story
 * for a request this small.
 */
export function pokeSessionForInterimSummary(sessionId: string): void {
  if (!sessionId || inFlight.has(sessionId)) return;
  inFlight.add(sessionId);
  notify();
  void (async () => {
    try {
      await deliverEnvelope(sessionId, WAVE_POKE_PROMPT);
    } finally {
      inFlight.delete(sessionId);
      notify();
    }
  })();
}

/** Clears the process-local guard. Tests only. */
export function resetWavePokeForTests(): void {
  inFlight.clear();
  listeners.clear();
}
