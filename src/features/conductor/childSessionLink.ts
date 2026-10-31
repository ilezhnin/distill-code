import { useConductorGraphStore } from "./conductorGraphStore";
import type { SessionNode } from "./types";

/**
 * Where a session started by another session hangs in the conductor graph.
 *
 * One rule for every way a session starts another — the conductor's own
 * spawns, wave steps, and `flockctl session create --parent-session-id` from
 * any chat: the child's parent is the session that started it, and its root
 * is the parent's root, so a conductor's brigade stays one tree at every
 * depth. An ordinary chat registers no node of its own and is its own root,
 * which is how the sidebar tells a node-less parent from an orchestrator the
 * graph bound evicted (`agentTree.ts`, `anchorIdOf`).
 */
export interface ChildSessionLink {
  parentSessionId: string;
  rootConductorId: string;
  /** The parent's own node; absent for an ordinary chat. */
  parentNode: SessionNode | undefined;
}

/**
 * The link for a child of `parentSessionId`. `aliases` are other ids the
 * parent may be registered under — a chat's pre-promotion client id — so a
 * parent whose node still carries the alias is found all the same.
 */
export function childSessionLink(
  parentSessionId: string,
  aliases: ReadonlyArray<string | null | undefined> = [],
): ChildSessionLink {
  const graph = useConductorGraphStore.getState();
  let parentNode: SessionNode | undefined;
  for (const id of [parentSessionId, ...aliases]) {
    if (!id) continue;
    parentNode = graph.getNode(id);
    if (parentNode) break;
  }
  return {
    parentSessionId,
    rootConductorId:
      parentNode?.rootConductorId ?? parentNode?.sessionId ?? parentSessionId,
    parentNode,
  };
}
