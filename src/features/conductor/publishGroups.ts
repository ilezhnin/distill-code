/**
 * Which finished child sessions get published back to their parent as one
 * digest message.
 *
 * Pure grouping so it can be tested without a runtime: one group per
 * orchestrator turn, keyed by `parentSessionId` + `anchorMessageId`, with the
 * orchestrator's workers as leaves — or the orchestrator itself when it has
 * none. These are the legacy `managedBy: "ui"` trees still in operators'
 * localStorage, plus anything registered from outside the UI.
 *
 * **Wave children are deliberately not here.** Since 3a a wave publishes one
 * digest per `waveId` from `waveLifecycle.ts`, as part of its closed loop —
 * that is the only place that knows when every step is terminal, what the
 * revision cap has left, and that a verdict is expected back. Grouping wave
 * workers here as well would publish the same reports twice.
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
): PublishGroup[] {
  const orchestratorGroups = new Map<string, SessionNode[]>();

  for (const node of nodes) {
    if (!node.parentSessionId) continue;
    // Wave children belong to the wave's own digest, never to a group here.
    if (node.managedBy === "wave") continue;
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
  return groups;
}
