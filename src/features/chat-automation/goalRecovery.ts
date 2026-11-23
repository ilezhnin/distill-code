import { automationCopy as copy } from "./automationCopy";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  beginLoopTurn,
  loopDeliveryId,
  settleLoopTurn,
  tickChatLoops,
} from "./loopRuntime";
import { getChatLoops, hydrateChatLoops, useChatLoopStore } from "./loopStore";
import { goalTurnPrefix } from "./commands";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { getSessionPromptOwner } from "@/features/chat/lib/sessionPromptOwnership";
import { loadSessionMessages } from "@/features/chat/lib/sessionActivation";
import { loadSessionForFlockctl } from "@/features/flockctl/commands/runtime/sessions";
import { getChatGoal, hydrateChatGoals, useChatGoalStore } from "./goalStore";
import {
  settleGoalTurn,
  startRecoverableAutomation,
  tickChatGoal,
} from "./goalRuntime";

export async function restoreChatAutomation() {
  // Each document owns a separate automation. A failed read keeps that
  // document unwritable while the other one's timers can still start.
  for (const read of await Promise.allSettled([
    hydrateChatGoals(),
    hydrateChatLoops(),
  ])) {
    if (read.status === "rejected")
      console.error("Could not hydrate chat automation:", read.reason);
  }
  const goals = useChatGoalStore.getState().goals;
  const recovering = new Set([
    ...Object.keys(goals),
    ...Object.keys(useChatLoopStore.getState().loops),
  ]);
  const { dispose, wake } = startRecoverableAutomation(recovering);
  await Promise.all(
    [...recovering].map(async (id) => {
      const goal = goals[id];
      try {
        const session =
          useChatSessionStore.getState().getSession(id) ??
          (await loadSessionForFlockctl(id));
        if (session.archivedAt) {
          useChatGoalStore.getState().clear(id);
          useChatLoopStore.getState().clear(id);
        } else if (
          (goal?.status === "active" ||
            getChatLoops(id).some(
              (loop) => loop.status === "active" || loop.pending,
            )) &&
          !getSessionPromptOwner(id)
        ) {
          // The history and the goal document flush independently. A turn can
          // already be on disk while its turn counter still says it is due.
          if (!(await loadSessionMessages(id)))
            throw new Error("Could not load the chat transcript.");
          if (getSessionPromptOwner(id)) return;
          const history = useChatStore.getState().messagesBySession[id] ?? [];
          for (const loop of getChatLoops(id)) {
            // Acknowledgement can reach history before the timer document.
            const accepted = history.find(
              (m) =>
                m.role === "user" &&
                m.metadata?.distillDeliveryId === loopDeliveryId(loop),
            );
            if (accepted && !loop.pending)
              beginLoopTurn(id, loop, accepted.id, accepted.created);
            const pending = loop.pending?.messageId ?? accepted?.id;
            if (pending) settleLoopTurn(id, pending, undefined, true);
          }
          if (!goal || getChatGoal(id) !== goal || goal.status !== "active")
            return;
          const prefix = goalTurnPrefix(goal.id);
          const latest = useChatStore
            .getState()
            .messagesBySession[id]?.filter(
              (m) =>
                m.role === "user" &&
                m.metadata?.distillDeliveryId?.startsWith(prefix),
            )
            .at(-1);
          const turns = Number(
            latest?.metadata?.distillDeliveryId?.slice(prefix.length),
          );
          let pending = goal.pendingMessageId;
          if (latest && Number.isSafeInteger(turns) && turns > goal.turns) {
            pending = latest.id;
            useChatGoalStore
              .getState()
              .update(id, { turns, pendingMessageId: pending });
          }
          if (pending) settleGoalTurn(id, pending);
        }
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "session_not_found"
        ) {
          useChatGoalStore.getState().clear(id);
          useChatLoopStore.getState().clear(id);
        } else {
          for (const loop of getChatLoops(id))
            useChatLoopStore
              .getState()
              .pause(
                id,
                loop.id,
                copy("restoreFailed", { reason: String(error) }),
              );
          useChatGoalStore
            .getState()
            .pause(id, copy("restoreFailed", { reason: String(error) }));
        }
      } finally {
        recovering.delete(id);
        tickChatLoops(id);
        tickChatGoal(id);
        wake();
      }
    }),
  );
  return dispose;
}
