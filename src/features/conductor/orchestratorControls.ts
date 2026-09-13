/**
 * Stopping one agent session the app started.
 *
 * Shared by the wave stop (5b), the blocked-step stop, the budget brake and the
 * agent tree's per-child stop button, so "stopped" means the same thing
 * everywhere: the node is cancelled, nothing more will be sent to that session,
 * and its turn — if it has one — is cancelled.
 */

import { acpCancelSession } from "@/shared/api/acp";
import { useChatStore } from "@/features/chat/stores/chatStore";

import { useConductorGraphStore } from "./conductorGraphStore";

export async function stopOrchestratorSession(
  sessionId: string,
): Promise<void> {
  const graph = useConductorGraphStore.getState();
  const node = graph.getNode(sessionId);
  if (!node) return;
  graph.patchNode(sessionId, { status: "cancelled" });
  const chat = useChatStore.getState();
  // The queue first, and before the session is marked idle. A wave child's
  // first prompt is *queued*, not sent: it waits for the cross-session drain,
  // which fires as soon as the session reports idle — which the two lines
  // below do. So a stop that only cancelled the (non-existent) turn handed the
  // drain a ready session and a pending prompt, the executor started working a
  // moment after being stopped, and `statusFromRuntime` put the node back to
  // `running` while its wave step stayed terminal: an agent editing the
  // working folder that nothing digests, stops or reports (§5 risk 7).
  for (const record of chat.queuedMessageBySession[sessionId] ?? []) {
    chat.dismissQueuedMessage(sessionId, record.recordId);
  }
  chat.setRunCancellationPending(sessionId, true);
  chat.setChatState(sessionId, "idle");
  try {
    await acpCancelSession(sessionId);
  } catch {
    // The child may have already finished.
  }
  chat.setRunCancellationPending(sessionId, false);
}
