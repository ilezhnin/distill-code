/**
 * Is this session the wave engine's, rather than the operator's?
 *
 * Read through the graph store rather than the session store because
 * `managedBy` is the graph's fact about a node, not the chat's about a
 * session, and the graph is the only place that distinction is recorded.
 *
 * …and through the memory store's persisted record of former executors,
 * because the graph is bounded and a finished wave child's node is the first
 * thing it evicts. After that the graph alone would call an executor's chat the
 * operator's own — and the callers of this use it to decide what reaches that
 * chat's prompt, including the operator's `<memory>` block, which
 * LAWS/MEMORY.md (Writing) forbids a wave-spawned executor from receiving. The
 * record is kept by the memory store because it exists to keep that promise; it
 * is read here so every caller of this predicate inherits the answer.
 *
 * Callers use it to stay out of the engine's way: a wave child is scheduled,
 * reported and reconciled by its conductor, and anything the app would
 * otherwise say to it — or ask of it — has to go through that loop instead.
 */

import { isWaveExecutorSession } from "@/features/memory/lib/memoryWriteAccess";

export function isWaveManagedSession(
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  return isWaveExecutorSession(sessionId);
}
