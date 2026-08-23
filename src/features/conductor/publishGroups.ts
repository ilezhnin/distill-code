/**
 * Which finished child sessions get published back to their parent as one
 * synthetic summary message.
 *
 * Pure grouping so both shapes can be tested without a runtime:
 * - legacy orchestrator shells (`managedBy: "ui"` trees still in operators'
 *   localStorage): one group per orchestrator turn, leaves are the
 *   orchestrator's workers, or the orchestrator itself when it has none;
 * - wave workers (`managedBy: "wave"`): one group per plan message, leaves are
 *   the workers themselves — a wave has no orchestrator shell. A wave that is
 *   still live is skipped entirely: its already-finished steps are not the
 *   turn's result, and publishing them would mark their reports published and
 *   silently swallow the steps that had not started yet.
 *
 * This is the bridge until 3a replaces synthetic publishing with a real digest
 * message to the conductor.
 */

import type { SessionNode } from "./types";

export interface PublishGroup {
  /** Session the summary message is appended to. */
  parentSessionId: string;
  /** Stable identity of the turn being published. */
  key: string;
  /** Nodes whose reports make up the summary, in a stable order. */
  leaves: readonly SessionNode[];
}

function turnKey(node: SessionNode): string {
  return node.anchorMessageId ?? node.runId ?? node.sessionId;
}

function orderLeaves(leaves: SessionNode[]): SessionNode[] {
  return [...leaves].sort((left, right) => {
    const leftStep = left.stepIndex ?? Number.MAX_SAFE_INTEGER;
    const rightStep = right.stepIndex ?? Number.MAX_SAFE_INTEGER;
    if (leftStep !== rightStep) return leftStep - rightStep;
    return (left.createdAt ?? 0) - (right.createdAt ?? 0);
  });
}

/**
 * Groups publishable turns out of the whole graph.
 *
 * `workersOf` returns a node's worker children; it is passed in so the caller
 * keeps ownership of the graph lookup.
 */
export function groupPublishableTurns(
  nodes: readonly SessionNode[],
  workersOf: (parentSessionId: string) => readonly SessionNode[],
  /**
   * True while the wave still has steps to spawn or finish. Groups of an open
   * wave are withheld until it is over.
   */
  isWaveOpen: (waveId: string) => boolean = () => false,
): PublishGroup[] {
  const orchestratorGroups = new Map<string, SessionNode[]>();
  const waveGroups = new Map<string, SessionNode[]>();

  for (const node of nodes) {
    if (!node.parentSessionId) continue;
    if (node.managedBy === "wave") {
      // Only wave-managed workers are leaves of a wave; anything else under a
      // conductor keeps its own path.
      if (node.role !== "worker") continue;
      if (node.waveId && isWaveOpen(node.waveId)) continue;
      const key = `${node.parentSessionId}::${turnKey(node)}`;
      const group = waveGroups.get(key) ?? [];
      group.push(node);
      waveGroups.set(key, group);
      continue;
    }
    if (node.role !== "orchestrator") continue;
    const key = `${node.parentSessionId}::${turnKey(node)}`;
    const group = orchestratorGroups.get(key) ?? [];
    group.push(node);
    orchestratorGroups.set(key, group);
  }

  const groups: PublishGroup[] = [];
  for (const [key, shells] of orchestratorGroups) {
    const parentSessionId = shells[0]?.parentSessionId;
    if (!parentSessionId) continue;
    const leaves = shells.flatMap((shell) => {
      const workers = workersOf(shell.sessionId);
      return workers.length > 0 ? [...workers] : [shell];
    });
    groups.push({ parentSessionId, key, leaves: orderLeaves(leaves) });
  }
  for (const [key, workers] of waveGroups) {
    const parentSessionId = workers[0]?.parentSessionId;
    if (!parentSessionId) continue;
    groups.push({ parentSessionId, key, leaves: orderLeaves(workers) });
  }
  return groups;
}
