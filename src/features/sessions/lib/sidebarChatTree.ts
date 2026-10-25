import type { AgentTreeNode } from "@/features/conductor/agentTree";
import type { RunStatus, SessionNode } from "@/features/conductor/types";
import type { SidebarSessionItem } from "@/features/sessions/ui/session-list/SidebarProjectSection";

/**
 * The agents a chat started, as the sidebar rows nested under it.
 *
 * The graph knows the shape (who started whom, in what order, with what
 * status); the session store knows the chat behind each node (its title, its
 * unread state, whether it is streaming right now). A child row is the chat
 * where one is loaded, and the node where one is not — an agent that has only
 * just been registered, or whose chat sits past the loaded page of history,
 * still gets a row, because an agent working on the operator's behalf must be
 * visible from the place they look.
 */

/**
 * What the session store knows about a child: its sidebar item, `"archived"`
 * for a chat the operator put away, `undefined` for one that is not loaded.
 */
export type ChildChatLookup = (
  sessionId: string,
) => SidebarSessionItem | "archived" | undefined;

/**
 * Whether an agent's own chat is busy, from its run status alone.
 *
 * `waiting` is deliberately not busy: that agent's chat is idle while the
 * agents it started work, and its row says so with the child-work ring
 * rather than the running pulse.
 */
export function isAgentChatBusy(status: RunStatus): boolean {
  return status === "starting" || status === "running";
}

export function childChatItems(
  forest: readonly AgentTreeNode[],
  lookup: ChildChatLookup,
): SidebarSessionItem[] {
  const items: SidebarSessionItem[] = [];
  for (const tree of forest) {
    const known = lookup(tree.node.sessionId);
    // An archived agent is out of the sidebar with everything under it — unless
    // something under it is still working, in which case the row stays so the
    // working agent remains reachable from the chat that is waiting on it.
    if (known === "archived" && tree.workingInSubtree === 0) continue;
    const base =
      known === undefined || known === "archived"
        ? itemFromAgentNode(tree.node)
        : known;
    const children = childChatItems(tree.children, lookup);
    items.push({
      ...base,
      isRunning: Boolean(base.isRunning) || isAgentChatBusy(tree.node.status),
      ...(children.length > 0 ? { children } : {}),
    });
  }
  return items;
}

function isoOrNull(epochMs: number | undefined): string | null {
  if (epochMs === undefined || !Number.isFinite(epochMs)) return null;
  return new Date(epochMs).toISOString();
}

function itemFromAgentNode(node: SessionNode): SidebarSessionItem {
  return {
    id: node.sessionId,
    title: node.displayName,
    updatedAt: isoOrNull(node.createdAt) ?? "",
    activityAt: isoOrNull(node.finishedAt ?? node.createdAt),
    projectId: node.projectId || undefined,
    isRunning: false,
    hasUnread: false,
  };
}
