import type { SessionNode } from "./types";

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

export function footerAgentNodes(
  nodesById: Record<string, SessionNode>,
  root: SessionNode | undefined,
  aliases: Array<string | null | undefined> = [],
): SessionNode[] {
  if (!root) return [];
  const rootIds = new Set(
    [root.sessionId, ...aliases].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    ),
  );
  if (root.role === "conductor") {
    return Object.values(nodesById).filter(
      (node) =>
        (node.role === "orchestrator" || node.role === "worker") &&
        Boolean(
          (node.rootConductorId && rootIds.has(node.rootConductorId)) ||
            (node.parentSessionId && rootIds.has(node.parentSessionId)),
        ),
    );
  }
  if (root.role === "orchestrator") {
    return Object.values(nodesById).filter(
      (node) =>
        node.role === "worker" &&
        Boolean(node.parentSessionId && rootIds.has(node.parentSessionId)),
    );
  }
  return [];
}
