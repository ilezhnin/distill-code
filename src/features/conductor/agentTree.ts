import { isWorkingStatus } from "./brigadeActivity";
import type { SessionNode } from "./types";

/**
 * The conductor graph as a tree, which is how the operator actually thinks
 * about it.
 *
 * Every surface built so far shows one *level* of the graph: a conductor's
 * chips, a conductor's wait line, a conductor's digest. That is enough while
 * a wave is flat, and it stops being enough the moment a step is an
 * orchestrator that spawns its own workers — the operator sees "4 executors
 * are working", opens one, and the agents it in turn started are nowhere.
 * Transparency is a product rule here, not a nicety: an agent that is working
 * on the operator's behalf must be visible, and reachable, from wherever its
 * existence is being claimed.
 *
 * So the shape is built once, here, from the raw node map, and every surface
 * that wants "who is working, under whom" renders the same forest.
 */

export interface AgentTreeNode {
  node: SessionNode;
  /** 0 for a root of the returned forest. */
  depth: number;
  children: AgentTreeNode[];
  /**
   * Nodes in this subtree that are still working, counting this one.
   *
   * A collapsed row has to be able to say "3 working underneath" without the
   * caller re-walking the tree, and a "live only" view has to keep a finished
   * orchestrator whose workers are still going — both read this.
   */
  workingInSubtree: number;
}

/**
 * Depth beyond which we stop descending.
 *
 * Nothing in the product builds a chain this deep; the cap is here because
 * the parent links are persisted data that a bad merge or a hand-edited
 * `localStorage` can turn into a cycle, and the renderer must not be the
 * thing that discovers it.
 */
const MAX_AGENT_TREE_DEPTH = 12;

export interface AgentForestOptions {
  /** Keep only nodes in this project. Omitted → every project. */
  projectId?: string | null;
  /**
   * Roots to build from, by session id. Omitted → every node that has no
   * parent inside the map becomes a root.
   *
   * Ids that name no node are ignored rather than rendered as empty rows: a
   * caller usually passes a session's own id plus its pre-promotion alias,
   * and only one of the two is ever in the graph.
   */
  rootSessionIds?: readonly string[];
  /**
   * `"live"` keeps only subtrees with a working agent somewhere in them —
   * the "who is busy right now" question. `"all"` keeps everything, which is
   * the history view. Defaults to `"all"`.
   */
  include?: "all" | "live";
  /** Drop the roots themselves and return their children as the forest. */
  excludeRoots?: boolean;
}

/**
 * The id a node hangs off, or `null` when it is a root of the whole graph.
 *
 * `parentSessionId` is the real edge. `rootConductorId` is the fallback for a
 * node whose parent is gone from the map — a worker under an orchestrator the
 * graph bound dropped would otherwise become a root of its own and float to
 * the top of the sidebar, which reads as "a second brigade started".
 */
function parentIdOf(
  node: SessionNode,
  nodesById: Record<string, SessionNode>,
): string | null {
  const parent = node.parentSessionId;
  if (parent && parent !== node.sessionId && nodesById[parent]) return parent;
  const root = node.rootConductorId;
  if (root && root !== node.sessionId && nodesById[root]) return root;
  return null;
}

/**
 * Siblings in the order the operator met them: wave steps by their step
 * number (so the tree reads like the plan), everything else oldest first,
 * name as the last tiebreak so the order never flickers between renders.
 */
function compareSiblings(a: SessionNode, b: SessionNode): number {
  const aStep = a.stepIndex ?? Number.POSITIVE_INFINITY;
  const bStep = b.stepIndex ?? Number.POSITIVE_INFINITY;
  if (aStep !== bStep) return aStep - bStep;
  const aAt = a.createdAt ?? 0;
  const bAt = b.createdAt ?? 0;
  if (aAt !== bAt) return aAt - bAt;
  return a.displayName.localeCompare(b.displayName);
}

export function buildAgentForest(
  nodesById: Record<string, SessionNode>,
  options: AgentForestOptions = {},
): AgentTreeNode[] {
  const { projectId, rootSessionIds, include = "all", excludeRoots } = options;

  const inScope: SessionNode[] = [];
  for (const key in nodesById) {
    const node = nodesById[key];
    if (!node) continue;
    // The map is keyed by both a node's own id and, briefly, its pre-promotion
    // alias; taking only the canonical key keeps a session from appearing
    // twice under two names.
    if (node.sessionId !== key) continue;
    if (projectId != null && node.projectId !== projectId) continue;
    inScope.push(node);
  }

  const scopedById: Record<string, SessionNode> = {};
  for (const node of inScope) scopedById[node.sessionId] = node;

  const childrenByParent = new Map<string, SessionNode[]>();
  const roots: SessionNode[] = [];
  const explicitRoots = rootSessionIds
    ? new Set(rootSessionIds.filter((id) => Boolean(id)))
    : null;

  for (const node of inScope) {
    if (explicitRoots?.has(node.sessionId)) {
      roots.push(node);
      continue;
    }
    const parent = parentIdOf(node, scopedById);
    if (parent === null) {
      if (!explicitRoots) roots.push(node);
      continue;
    }
    const bucket = childrenByParent.get(parent);
    if (bucket) bucket.push(node);
    else childrenByParent.set(parent, [node]);
  }

  const seen = new Set<string>();
  const build = (node: SessionNode, depth: number): AgentTreeNode => {
    seen.add(node.sessionId);
    const children =
      depth >= MAX_AGENT_TREE_DEPTH
        ? []
        : (childrenByParent.get(node.sessionId) ?? [])
            .filter((child) => !seen.has(child.sessionId))
            .sort(compareSiblings)
            .map((child) => build(child, depth + 1));
    const workingInSubtree =
      (isWorkingStatus(node.status) ? 1 : 0) +
      children.reduce((sum, child) => sum + child.workingInSubtree, 0);
    return { node, depth, children, workingInSubtree };
  };

  const forest = roots.sort(compareSiblings).map((node) => build(node, 0));
  const promoted = excludeRoots
    ? forest.flatMap((root) => root.children.map(reseat))
    : forest;
  return include === "live" ? keepLive(promoted) : promoted;
}

/** Re-bases a subtree so its own depth becomes 0. */
function reseat(tree: AgentTreeNode, depth = 0): AgentTreeNode {
  return {
    ...tree,
    depth,
    children: tree.children.map((child) => reseat(child, depth + 1)),
  };
}

/**
 * Keeps only what is still working, and whoever it is working under.
 *
 * A finished orchestrator with a running worker stays — dropping it would
 * orphan the worker and lose the one fact that explains why it is running.
 */
function keepLive(forest: readonly AgentTreeNode[]): AgentTreeNode[] {
  const kept: AgentTreeNode[] = [];
  for (const tree of forest) {
    if (tree.workingInSubtree === 0) continue;
    kept.push({ ...tree, children: keepLive(tree.children) });
  }
  return kept;
}

/** Depth-first, parents before children — the order the rows are drawn in. */
export function flattenAgentForest(
  forest: readonly AgentTreeNode[],
): AgentTreeNode[] {
  const rows: AgentTreeNode[] = [];
  const walk = (tree: AgentTreeNode) => {
    rows.push(tree);
    for (const child of tree.children) walk(child);
  };
  for (const tree of forest) walk(tree);
  return rows;
}

/** Total agents in a forest, at every depth. */
export function countAgents(forest: readonly AgentTreeNode[]): number {
  return forest.reduce((sum, tree) => sum + 1 + countAgents(tree.children), 0);
}

/** Working agents in a forest, at every depth. */
export function countWorkingAgents(forest: readonly AgentTreeNode[]): number {
  return forest.reduce((sum, tree) => sum + tree.workingInSubtree, 0);
}

/** The subtree for one session, or `null` when it is not in the forest. */
export function findAgentSubtree(
  forest: readonly AgentTreeNode[],
  sessionId: string,
): AgentTreeNode | null {
  for (const tree of forest) {
    if (tree.node.sessionId === sessionId) return tree;
    const found = findAgentSubtree(tree.children, sessionId);
    if (found) return found;
  }
  return null;
}
