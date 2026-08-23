import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import type { ChatState } from "@/shared/types/chat";

import { isAgentChildOfRoot, rootSessionIdSet } from "./sessionVisibility";
import type { RunStatus, SessionNode } from "./types";

/**
 * A child run that has not reached a terminal state yet: the operator is still
 * waiting on it. `managedBy` is deliberately irrelevant here — UI-spawned,
 * wave-driven and CLI-registered children all count the same.
 */
export function isWorkingStatus(status: RunStatus): boolean {
  return status === "starting" || status === "running" || status === "waiting";
}

export interface BrigadeActivity {
  working: number;
  done: number;
}

/** Working/done tallies over a session's graph children. */
export function summarizeBrigadeActivity(
  nodes: readonly SessionNode[],
): BrigadeActivity {
  let working = 0;
  let done = 0;
  for (const node of nodes) {
    if (isWorkingStatus(node.status)) working += 1;
    else if (node.status === "completed") done += 1;
  }
  return { working, done };
}

export interface BrigadeWaitIndicator {
  visible: boolean;
  workingCount: number;
}

/**
 * Decides whether the "waiting on external work" indicator belongs near the
 * composer, and with what count.
 *
 * Shown only when the session itself is idle (or errored — its own turn is
 * over either way) while at least one of its graph children is still
 * starting/running/waiting. `children` is expected to be the same node
 * selection the brigade footer uses (`footerAgentNodes`), which already
 * restricts to this session's own orchestrator/worker children.
 */
export function brigadeWaitIndicator(input: {
  chatState: ChatState;
  children: readonly SessionNode[];
}): BrigadeWaitIndicator {
  const workingCount = summarizeBrigadeActivity(input.children).working;
  return {
    visible: workingCount > 0 && !isSessionRunning(input.chatState),
    workingCount,
  };
}

/**
 * How many of a session's graph children are still working, straight off the
 * raw graph map.
 *
 * Exists for row-local subscribers (the sidebar chat row) that only have a
 * session id: returning a plain number keeps zustand's default `Object.is`
 * comparison sufficient, so no `useShallow` and no per-render array. The child
 * selection is `isAgentChildOfRoot` — the same rule `footerAgentNodes` uses —
 * so the sidebar and the composer indicator can never disagree.
 *
 * Returns 0 when the session has no node, is not a conductor/orchestrator, or
 * has no working children. Says nothing about the session's *own* run state;
 * callers decide that (the sidebar row lets its own running state win).
 */
export function workingChildCountForSession(
  nodesById: Record<string, SessionNode>,
  sessionId: string,
  aliases: Array<string | null | undefined> = [],
): number {
  let root = nodesById[sessionId];
  if (!root) {
    for (const alias of aliases) {
      if (typeof alias === "string" && alias.length > 0 && nodesById[alias]) {
        root = nodesById[alias];
        break;
      }
    }
  }
  if (!root) return 0;
  if (root.role !== "conductor" && root.role !== "orchestrator") return 0;

  const rootIds = rootSessionIdSet(root, [sessionId, ...aliases]);
  let working = 0;
  // `for..in` rather than `Object.values`: this runs once per visible sidebar
  // row on every graph mutation, so it stays free of intermediate arrays.
  for (const key in nodesById) {
    const node = nodesById[key];
    if (!node || !isWorkingStatus(node.status)) continue;
    if (isAgentChildOfRoot(node, root.role, rootIds)) working += 1;
  }
  return working;
}
