/**
 * The graph store's bound — the pure half.
 *
 * `conductorGraphStore` persists every node and report it has ever seen and,
 * until this module, never deleted anything: each wave adds workers and
 * reports forever, so the store was the one state in the feature that grew
 * without limit. This trims it back on the growth paths.
 *
 * What may be evicted is deliberately narrow:
 * - never a conductor — those are the operator's own chats, and there are
 *   only ever a handful;
 * - never a node that is still working — a live run must stay attributable;
 * - never a child of a live wave, whatever its status — the wave engine
 *   reconciles against these nodes every tick, and evicting one mid-wave
 *   would re-run its step from `pending` (the exact resurrection bug the
 *   engine's `failed` guard exists to prevent);
 * - among the evictable, oldest finished first — attribution for recent
 *   waves is an operator affordance, attribution for the distant past is
 *   what telemetry records are for.
 *
 * Reports follow their nodes: a report whose node was evicted (or never
 * existed) is unreachable by every renderer, and is dropped once the report
 * map itself is over its own bound. Orphans are never dropped while under
 * the bound, so the (never observed, node-registers-first) window where a
 * report lands before its node cannot lose a live report.
 */

import type { SessionNode, StructuredReport } from "./types";
import { isTerminalRunStatus } from "./waveEngine";

export const MAX_GRAPH_NODES = 500;
export const MAX_GRAPH_REPORTS = 500;

export interface ConductorGraphSlices {
  nodesById: Record<string, SessionNode>;
  reportsByRunId: Record<string, StructuredReport>;
}

let warnedOverBound = false;

/** Test seam for the one-per-process over-bound warning. */
export function resetGraphBoundsWarningForTests(): void {
  warnedOverBound = false;
}

function evictionAge(node: SessionNode): number {
  return node.finishedAt ?? node.createdAt ?? 0;
}

/**
 * Returns the state trimmed to its bounds — or the same object when nothing
 * had to move, so zustand set() callers can skip the write.
 */
export function boundConductorGraph(
  state: ConductorGraphSlices,
  liveWaveIds: ReadonlySet<string>,
): ConductorGraphSlices {
  const nodes = Object.values(state.nodesById);
  let nodesById = state.nodesById;
  let changed = false;

  const overBy = nodes.length - MAX_GRAPH_NODES;
  if (overBy > 0) {
    const evictable = nodes
      .filter(
        (node) =>
          node.role !== "conductor" &&
          isTerminalRunStatus(node.status) &&
          (!node.waveId || !liveWaveIds.has(node.waveId)),
      )
      .sort((left, right) => evictionAge(left) - evictionAge(right));
    const evicted = evictable.slice(0, overBy);
    if (evicted.length > 0) {
      nodesById = { ...state.nodesById };
      for (const node of evicted) delete nodesById[node.sessionId];
      changed = true;
    }
    if (evicted.length < overBy && !warnedOverBound) {
      // The visible quota failure: every entry over the bound is live, so
      // nothing can be evicted. This is not a state the app can reach with
      // one operator (live waves are capped per conductor), so if it is ever
      // seen, something is failing to go terminal.
      warnedOverBound = true;
      console.warn(
        `conductor graph is over its bound by ${overBy - evicted.length} entries that are all still live`,
      );
    }
  }

  const reportCount = Object.keys(state.reportsByRunId).length;
  if (reportCount > MAX_GRAPH_REPORTS) {
    const referencedRunIds = new Set(
      Object.values(nodesById).flatMap((node) =>
        node.runId ? [node.runId] : [],
      ),
    );
    const orphanRunIds = Object.keys(state.reportsByRunId).filter(
      (runId) => !referencedRunIds.has(runId),
    );
    // Published orphans first: an unpublished one is closer to being needed.
    orphanRunIds.sort((left, right) => {
      const leftPublished = state.reportsByRunId[left]?.publishedToParent
        ? 0
        : 1;
      const rightPublished = state.reportsByRunId[right]?.publishedToParent
        ? 0
        : 1;
      return leftPublished - rightPublished;
    });
    const dropCount = Math.min(
      orphanRunIds.length,
      reportCount - MAX_GRAPH_REPORTS,
    );
    if (dropCount > 0) {
      const reportsByRunId = { ...state.reportsByRunId };
      for (const runId of orphanRunIds.slice(0, dropCount)) {
        delete reportsByRunId[runId];
      }
      return { nodesById, reportsByRunId };
    }
  }

  return changed ? { ...state, nodesById } : state;
}
