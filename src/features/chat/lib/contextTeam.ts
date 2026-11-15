/**
 * The agents whose context windows a chat's rail lists: the chat that started
 * the work, and everyone working under it.
 *
 * A conductor's executors run on different harnesses and different models, so
 * each has a window of its own size, filling at its own rate. The operator
 * watches them as one team: the question is "who is about to run out", asked
 * from whichever chat of the team happens to be open. So the team is the same
 * tree from every seat in it — rooted at the chat nothing started, down to the
 * last agent — and the open chat is only marked, not made the root.
 *
 * Pure: the graph and the session list go in, rows come out.
 */

import {
  flattenAgentForest,
  indexAgentChildren,
} from "@/features/conductor/agentTree";
import type { SessionNode } from "@/features/conductor/types";

/** What a team row needs from a chat the session list knows. */
export interface ContextTeamSession {
  id: string;
  clientSessionId?: string | null;
  title: string;
  /** Set once the operator has put the chat away. */
  archivedAt?: string | null;
}

export interface ContextTeamMember {
  /** The id the chat is opened by, and its usage is read under. */
  sessionId: string;
  /**
   * The agent's name. Absent only for a root that has neither a graph node
   * nor a loaded chat; the UI supplies a localized stand-in.
   */
  name?: string;
  /** 0 for the chat the team hangs under. */
  depth: number;
  /**
   * The agent's graph node. Absent for an ordinary chat that started agents:
   * it registers no node of its own.
   */
  node?: SessionNode;
  /** The chat this rail belongs to. */
  isCurrent: boolean;
}

export interface ContextTeamInput {
  nodesById: Record<string, SessionNode>;
  /**
   * Every id the open chat answers to: its own, and the one it had before the
   * host confirmed it (an agent registered early still points at that one).
   */
  currentIds: ReadonlyArray<string | null | undefined>;
  /** A chat by any of its ids, when the session list holds it. */
  resolveSession: (sessionId: string) => ContextTeamSession | undefined;
}

function uniqueIds(ids: Iterable<string | null | undefined>): string[] {
  const unique: string[] = [];
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0 && !unique.includes(id)) {
      unique.push(id);
    }
  }
  return unique;
}

/**
 * The team the open chat belongs to, parents before children.
 *
 * Empty when the chat started nothing and nothing started it: a chat on its
 * own has one window, and the rail already shows it above the list.
 */
export function buildContextTeam({
  nodesById,
  currentIds,
  resolveSession,
}: ContextTeamInput): ContextTeamMember[] {
  const ownIds = uniqueIds(currentIds);
  if (ownIds.length === 0) return [];

  const index = indexAgentChildren(nodesById);
  // Only one of a chat's ids is ever in the graph, so the longest chain is
  // the chain.
  let ancestors: string[] = [];
  for (const id of ownIds) {
    const chain = index.ancestorsOf(id);
    if (chain.length > ancestors.length) ancestors = chain;
  }

  const topId = ancestors.at(-1);
  const rootSession = resolveSession(topId ?? ownIds[0]);
  const rootIds = uniqueIds([
    ...(topId ? [topId] : ownIds),
    rootSession?.id,
    rootSession?.clientSessionId,
  ]);
  const forest = index.forestUnder(rootIds);
  if (forest.length === 0) return [];

  const rootNode = rootIds
    .map((id) => nodesById[id])
    .find((node): node is SessionNode => Boolean(node));
  const isCurrent = (id: string) => ownIds.includes(id);

  const root: ContextTeamMember = {
    sessionId: rootSession?.id ?? rootNode?.sessionId ?? rootIds[0],
    name: rootNode?.displayName ?? rootSession?.title,
    depth: 0,
    ...(rootNode ? { node: rootNode } : {}),
    isCurrent: rootIds.some(isCurrent),
  };
  // An agent whose chat was archived is one the operator put away, and the
  // sidebar no longer lists it; neither does the team. The open chat stays
  // even when archived: it is the one being looked at.
  const agents = flattenAgentForest(forest)
    .map(
      (tree): ContextTeamMember => ({
        sessionId: tree.node.sessionId,
        name: tree.node.displayName,
        depth: tree.depth + 1,
        node: tree.node,
        isCurrent: isCurrent(tree.node.sessionId),
      }),
    )
    .filter(
      (member) =>
        member.isCurrent || !resolveSession(member.sessionId)?.archivedAt,
    );
  return agents.length > 0 ? [root, ...agents] : [];
}

/** A window's figures, however they were learned. */
export interface ContextWindowUsage {
  used: number;
  /** 0 when the harness has not named the window's size. */
  limit: number;
}

/**
 * The share of the window in use, 0..1, or `null` when the size is unknown —
 * a harness that reports tokens but no window has a count, not a percentage.
 */
export function contextWindowShare(usage: ContextWindowUsage): number | null {
  if (!(usage.limit > 0)) return null;
  return Math.min(Math.max(usage.used / usage.limit, 0), 1);
}

/**
 * How close a window is to full, as the three states the rail colors.
 *
 * The thresholds are where the operator's options change, not round numbers:
 * past 70% a long step may not fit and the agent is worth compacting or
 * replacing between tasks; past 90% the next turn can fail outright.
 */
export type ContextWindowPressure = "normal" | "high" | "critical";

export const CONTEXT_PRESSURE_HIGH = 0.7;
export const CONTEXT_PRESSURE_CRITICAL = 0.9;

export function contextWindowPressure(
  share: number | null,
): ContextWindowPressure {
  if (share === null) return "normal";
  if (share >= CONTEXT_PRESSURE_CRITICAL) return "critical";
  if (share >= CONTEXT_PRESSURE_HIGH) return "high";
  return "normal";
}
