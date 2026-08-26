/**
 * Who may write to the operator's memory.
 *
 * Reading is broad on purpose — every ordinary session gets the `<memory>`
 * block — but writing is the conductor's side of the bargain: a session that
 * is a node on the conductor graph only applies `distill-memory` fences when
 * its layer says so. The conductor writes; an orchestrator writes only when
 * its persona carries the `memory_write` grant; a worker or wave child never
 * does — it is a one-shot task runner whose report already goes through the
 * conductor's loop, and that loop is where any fact it learned belongs.
 *
 * A session with no node on the graph is an ordinary operator chat and writes
 * exactly as before this module existed. That default is the guardrail for
 * the manual checklist's C-scenarios: nothing here may cost a plain chat its
 * memory.
 *
 * `decideMemoryWrite` is pure; `sessionMemoryWriteAccess` wires it to the
 * graph and agent stores for the callers that live outside React.
 */

import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import type { SessionNode } from "@/features/conductor/types";

/** Why a session's fence is not applied. Enumerated for notices and tests. */
export type MemoryWriteDenial =
  /** A wave-engine child, whatever role it was spawned with. */
  | "wave-child"
  /** A worker-layer node outside the wave engine (legacy trees, agent-cli). */
  | "worker"
  /** An orchestrator whose persona does not carry `memory_write: true`. */
  | "orchestrator-without-grant";

export type MemoryWriteDecision =
  | { allowed: true }
  | { allowed: false; denial: MemoryWriteDenial };

const ALLOWED: MemoryWriteDecision = { allowed: true };

/**
 * The layer rule, applied to one graph node — or to no node at all, which is
 * every ordinary chat and always allowed.
 */
export function decideMemoryWrite(
  node: Pick<SessionNode, "role" | "managedBy" | "personaId"> | undefined,
  personaGrantsWrite: (personaId: string | undefined) => boolean,
): MemoryWriteDecision {
  if (!node) return ALLOWED;
  // The wave engine's children are checked before the role: a wave child is
  // cut off from the memory prompt entirely (queuedSessionSend/backgroundSend
  // already do that), so a fence from one is a protocol it was never taught.
  if (node.managedBy === "wave")
    return { allowed: false, denial: "wave-child" };
  switch (node.role) {
    case "conductor":
    case "plain-chat":
      // A plain-chat node is still the operator's own conversation; only the
      // graph's record of it differs from an unregistered session.
      return ALLOWED;
    case "worker":
      return { allowed: false, denial: "worker" };
    case "orchestrator":
      return personaGrantsWrite(node.personaId)
        ? ALLOWED
        : { allowed: false, denial: "orchestrator-without-grant" };
  }
}

/** True when the persona exists and carries a validated `memory_write: true`. */
export function personaGrantsMemoryWrite(
  personaId: string | undefined,
): boolean {
  if (!personaId) return false;
  return (
    useAgentStore.getState().getPersonaById(personaId)?.memoryWrite === true
  );
}

/** The decision for a live session, read from the stores as they stand now. */
export function sessionMemoryWriteAccess(
  sessionId: string | null | undefined,
): MemoryWriteDecision {
  if (!sessionId) return ALLOWED;
  return decideMemoryWrite(
    useConductorGraphStore.getState().nodesById[sessionId],
    personaGrantsMemoryWrite,
  );
}

/**
 * Operator-readable line for a refused fence. English on purpose, like the
 * graph's own console warnings — this is diagnostics, not chrome.
 */
export function memoryWriteDenialText(denial: MemoryWriteDenial): string {
  switch (denial) {
    case "wave-child":
      return "a wave child cannot write to the operator's memory; its findings belong in its report";
    case "worker":
      return "a worker-layer session cannot write to the operator's memory; its findings belong in its report";
    case "orchestrator-without-grant":
      return "this orchestrator's persona does not carry memory_write: true, so its memory request is not applied";
  }
}
