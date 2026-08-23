import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import type { ChatState } from "@/shared/types/chat";

import type { RunStatus, SessionNode } from "./types";

/**
 * Statuses that claim "this session is executing right now". A persisted graph
 * keeps them across an app restart even though nothing is running any more —
 * that is the staleness this module detects.
 */
function isWorkingStatus(status: RunStatus): boolean {
  return status === "starting" || status === "running" || status === "waiting";
}

/**
 * The slice of `SessionChatRuntime` that decides whether a session is live.
 * Deliberately loose so callers (and tests) can pass a runtime literal.
 */
export interface StaleStatusRuntime {
  chatState: ChatState;
  isRunCancellationPending?: boolean;
}

export interface StaleStatusReconcileContext {
  /** `useChatStore.getState().sessionStateById` (or an equivalent map). */
  sessionStateById: Readonly<Record<string, StaleStatusRuntime | undefined>>;
  /**
   * True when a queued/pending send for this session is still waiting to be
   * drained — i.e. the session is about to start on its own and must not be
   * reported as stopped.
   */
  hasQueuedFirstSend: (sessionId: string) => boolean;
}

/**
 * A runtime entry alone does not mean the session runs: the chat store seeds
 * `sessionStateById` with idle entries for sessions that merely carry an unread
 * flag. Only an actually busy runtime counts as live.
 *
 * `error` and a pending cancellation count as live on purpose: `statusFromRuntime`
 * turns them into `failed`/`cancelled`, which are more precise terminal statuses
 * than `stopped`.
 */
export function hasLiveRuntime(
  runtime: StaleStatusRuntime | undefined,
): boolean {
  if (!runtime) return false;
  if (runtime.isRunCancellationPending) return true;
  return isSessionRunning(runtime.chatState) || runtime.chatState === "error";
}

/**
 * One-shot startup reconcile: which orchestrator/worker nodes still claim to be
 * working while nothing backs that claim any more. Returns the session ids that
 * must be patched to `stopped`.
 *
 * Pure by design — the caller owns the store reads and the patching, so this
 * decision is unit-testable.
 *
 * Conductor (and plain-chat) nodes are never touched, and neither are terminal
 * statuses: `completed`, `failed`, `cancelled` and `stopped` stay as persisted.
 */
export function reconcileStaleGraphStatuses(
  nodes: Iterable<SessionNode>,
  context: StaleStatusReconcileContext,
): string[] {
  const staleSessionIds: string[] = [];
  for (const node of nodes) {
    if (node.role !== "orchestrator" && node.role !== "worker") continue;
    if (!isWorkingStatus(node.status)) continue;
    if (hasLiveRuntime(context.sessionStateById[node.sessionId])) continue;
    if (context.hasQueuedFirstSend(node.sessionId)) continue;
    staleSessionIds.push(node.sessionId);
  }
  return staleSessionIds;
}
