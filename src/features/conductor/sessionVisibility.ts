import type { SessionNode, SessionRole } from "./types";

export function nestedExecutorSessionIdSet(
  nodesById: Record<string, SessionNode>,
): Set<string> {
  const ids = new Set<string>();
  for (const node of Object.values(nodesById)) {
    if (node.role === "orchestrator" || node.role === "worker") {
      ids.add(node.sessionId);
    }
  }
  return ids;
}

export function isNestedExecutorSession(
  session: { id: string; clientSessionId?: string | null },
  nestedIds: ReadonlySet<string>,
): boolean {
  return (
    nestedIds.has(session.id) ||
    (session.clientSessionId != null && nestedIds.has(session.clientSessionId))
  );
}

/**
 * Every id a root session may be referenced by inside the graph: its own node
 * id plus any client-session aliases the caller knows about. A child spawned
 * before the client session was promoted still points at the alias, and
 * `remapSessionId` only rewrites those references once the *root's own* node
 * is keyed by the alias — so callers that have the alias must pass it.
 */
export function rootSessionIdSet(
  root: SessionNode,
  aliases: Array<string | null | undefined> = [],
): Set<string> {
  return new Set(
    [root.sessionId, ...aliases].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    ),
  );
}

/**
 * The one child-selection rule shared by every "this session's agents" surface
 * (brigade footer, sidebar indicator).
 *
 * A conductor root owns the orchestrator/worker nodes that point at it by
 * `rootConductorId` or directly by `parentSessionId`; an orchestrator root owns
 * its direct workers. Any other root role owns nothing. `managedBy` is
 * deliberately irrelevant — UI, wave and CLI children all count.
 */
export function isAgentChildOfRoot(
  node: SessionNode,
  rootRole: SessionRole,
  rootIds: ReadonlySet<string>,
): boolean {
  if (rootRole === "conductor") {
    return (
      (node.role === "orchestrator" || node.role === "worker") &&
      Boolean(
        (node.rootConductorId && rootIds.has(node.rootConductorId)) ||
          (node.parentSessionId && rootIds.has(node.parentSessionId)),
      )
    );
  }
  if (rootRole === "orchestrator") {
    return (
      node.role === "worker" &&
      Boolean(node.parentSessionId && rootIds.has(node.parentSessionId))
    );
  }
  return false;
}

export function footerAgentNodes(
  nodesById: Record<string, SessionNode>,
  root: SessionNode | undefined,
  aliases: Array<string | null | undefined> = [],
): SessionNode[] {
  if (!root) return [];
  const rootIds = rootSessionIdSet(root, aliases);
  return Object.values(nodesById).filter((node) =>
    isAgentChildOfRoot(node, root.role, rootIds),
  );
}
