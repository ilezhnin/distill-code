/**
 * The chips under a wave plan: one per step, spawned or not.
 *
 * A plan is a promise of N pieces of work, and the footer used to show only
 * the ones that had already been spawned. A four-step wave whose first step
 * was slow to start therefore rendered as a single chip — the operator could
 * not see the shape of what they had agreed to, only the part of it that had
 * happened to begin, and the row grew sideways as steps appeared.
 *
 * So the row is built from the plan, not from the graph, whenever this
 * message carried one: every step gets a chip, and a step with no node yet
 * gets a placeholder that says which role is coming and holds its place.
 *
 * Pure: the caller owns the graph, the reports and the translations.
 */

import type { WaveStep } from "./distillWave";
import { roleById } from "./roleCatalog";
import type { SessionNode } from "./types";

export interface WaveFooterSlot {
  /** Zero-based step this slot belongs to. */
  stepIndex: number;
  step: WaveStep;
  /** The child running it, once one exists. */
  node?: SessionNode;
}

/**
 * A readable name for a step nothing has spawned yet.
 *
 * The role's display name, because that is what the plan above the row calls
 * it and what the chip will keep calling it once the child exists — a
 * placeholder that renames itself on spawn would read as two different pieces
 * of work. An unknown role keeps its own id rather than becoming "Agent":
 * a plan that named something we do not have in the catalog is exactly the
 * case where the operator needs to see what it named.
 */
export function pendingStepName(step: WaveStep): string {
  const base = roleById(step.role)?.displayName ?? step.role;
  // A labelled step keeps its label from the placeholder on: the spawned
  // chip will read "Scout · <label>" (the worker's display name), and a
  // placeholder that says only "Scout" until then reads as a different step.
  return step.label ? `${base} · ${step.label}` : base;
}

/**
 * The whole footer row for one message: the plan's slots, then anything the
 * plan has no place for.
 *
 * A revision wave can leave children whose `stepIndex` is past the end of the
 * plan rendered here, and a legacy orchestrator child carries no index at all.
 * Dropping either would hide a real run, so every node that no slot claimed is
 * appended after the slots rather than lost.
 *
 * Without a plan there is nothing to hold places for: the answer is the nodes
 * as they are, which is the legacy row unchanged.
 */
export interface WaveFooterRow {
  slots: WaveFooterSlot[];
  unplanned: SessionNode[];
}

export function waveFooterRow(
  planSteps: readonly WaveStep[],
  nodes: readonly SessionNode[],
): WaveFooterRow {
  if (planSteps.length === 0) return { slots: [], unplanned: [...nodes] };

  const byStep = new Map<number, SessionNode>();
  for (const node of nodes) {
    const index = node.stepIndex;
    if (typeof index !== "number" || index < 0 || index >= planSteps.length) {
      continue;
    }
    // First writer wins; a second node claiming the same step falls through to
    // `unplanned` instead of disappearing.
    if (!byStep.has(index)) byStep.set(index, node);
  }
  const claimed = new Set([...byStep.values()].map((node) => node.sessionId));

  return {
    slots: planSteps.map((step, stepIndex) => {
      const node = byStep.get(stepIndex);
      return { stepIndex, step, ...(node ? { node } : {}) };
    }),
    unplanned: nodes.filter((node) => !claimed.has(node.sessionId)),
  };
}
