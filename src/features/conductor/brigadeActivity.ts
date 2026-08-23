import type { ChatState } from "@/shared/types/chat";

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

/** The chat's own turn is in flight (so the composer already shows activity). */
export function isSessionRunning(chatState: ChatState): boolean {
  return (
    chatState === "thinking" ||
    chatState === "streaming" ||
    chatState === "waiting" ||
    chatState === "compacting"
  );
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
