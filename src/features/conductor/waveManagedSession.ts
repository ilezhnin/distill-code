/**
 * Is this session the wave engine's, rather than the operator's?
 *
 * Read through the graph store rather than the session store because
 * `managedBy` is the graph's fact about a node, not the chat's about a
 * session, and the graph is the only place that distinction is recorded.
 *
 * Callers use it to stay out of the engine's way: a wave child is scheduled,
 * reported and reconciled by its conductor, and anything the app would
 * otherwise say to it — or ask of it — has to go through that loop instead.
 */

import { useConductorGraphStore } from "./conductorGraphStore";

export function isWaveManagedSession(
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  return (
    useConductorGraphStore.getState().nodesById[sessionId]?.managedBy === "wave"
  );
}
