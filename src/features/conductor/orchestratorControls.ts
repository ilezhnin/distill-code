/**
 * Stopping one agent session the app started.
 *
 * Shared by the wave stop (5b), the blocked-step stop, the budget brake and the
 * agent tree's per-child stop button, so "stopped" means the same thing
 * everywhere: queued future work is dismissed and any active turn is cancelled.
 * Owned graph outcomes come from native terminal acknowledgement; completed
 * runs keep their outcome when late cleanup reaches them.
 */

import { acpCancelSession } from "@/shared/api/acp";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { taskBindingId } from "@/features/chat/lib/executionOwnership";
import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import { benchmarkErrorMessage } from "@/features/benchmarks/api/benchmarks";
import { ownedTaskExecution } from "@/features/benchmarks/lib/ownedTaskExecution";

import { useConductorGraphStore } from "./conductorGraphStore";

export async function stopOrchestratorSession(
  sessionId: string,
): Promise<void> {
  const graph = useConductorGraphStore.getState();
  const node = graph.getNode(sessionId);
  if (!node) return;
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
  const bindingId = taskBindingId(sessionId);
  const terminal = ["completed", "failed", "cancelled", "stopped"].includes(
    node.status,
  );
  if (
    !bindingId &&
    terminal &&
    !isSessionRunning(chat.sessionStateById[sessionId]?.chatState ?? "idle")
  )
    return;
  if (!bindingId && !terminal)
    graph.patchNode(sessionId, { status: "cancelled" });
  chat.setRunCancellationPending(sessionId, true);
  try {
    const readNativeStatus = async (id: string) => {
      const status = await ownedTaskExecution.status(id);
      if (
        status &&
        (status.sessionId !== sessionId || status.requestKey !== node.runId)
      )
        throw new Error(
          "Native cancellation receipt belongs to another child run",
        );
      if (
        useConductorGraphStore.getState().getNode(sessionId)?.runId !==
        node.runId
      )
        throw new Error("The child run changed during native cancellation");
      return status;
    };
    const settleNativeTerminal = (
      status: Awaited<ReturnType<typeof readNativeStatus>>,
    ) => {
      if (status?.phase !== "terminal") return false;
      graph.patchNode(sessionId, {
        status: status.error
          ? status.error.kind === "cancelled"
            ? "cancelled"
            : "failed"
          : "completed",
      });
      chat.setRunCancellationPending(sessionId, false);
      chat.setChatState(sessionId, "idle");
      return true;
    };
    if (bindingId) {
      // A late cleanup must not turn a completed native run into a cancellation.
      // If the status read itself is unavailable, still attempt the dedicated
      // cancellation path; its result must be verified below before settling.
      let status: Awaited<ReturnType<typeof readNativeStatus>>;
      try {
        status = await ownedTaskExecution.status(bindingId);
      } catch {
        status = null;
      }
      if (
        status &&
        (status.sessionId !== sessionId || status.requestKey !== node.runId)
      )
        throw new Error(
          "Native cancellation receipt belongs to another child run",
        );
      if (
        useConductorGraphStore.getState().getNode(sessionId)?.runId !==
        node.runId
      )
        throw new Error("The child run changed during native cancellation");
      if (settleNativeTerminal(status)) return;
    }
    chat.setChatState(sessionId, "idle");
    await acpCancelSession(sessionId);
    if (bindingId) {
      const status = await readNativeStatus(bindingId);
      if (settleNativeTerminal(status)) return;
      if (status)
        throw new Error(
          "Native task cancellation has no terminal acknowledgement",
        );
      // No dispatch exists: the native cancel path stopped an unstarted task.
      graph.patchNode(sessionId, { status: "cancelled" });
    }
  } catch (error) {
    if (bindingId) {
      chat.setError(
        sessionId,
        `Native task cancellation is unresolved: ${benchmarkErrorMessage(error)}`,
      );
      throw error;
    }
    // The child may have already finished.
  }
  chat.setRunCancellationPending(sessionId, false);
}
