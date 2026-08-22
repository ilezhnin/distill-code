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
  chat.setRunCancellationPending(sessionId, true);
  chat.setChatState(sessionId, "idle");
  try {
    await acpCancelSession(sessionId);
  } catch {
    // The child may have already finished.
  }
  chat.setRunCancellationPending(sessionId, false);
}
