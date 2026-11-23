import { useChatStore } from "@/features/chat/stores/chatStore";
import { automationCopy as copy } from "./automationCopy";
import { goalTurnDeliveryId } from "./commands";
import { getChatGoal, useChatGoalStore } from "./goalStore";
import { getChatLoops, useChatLoopStore } from "./loopStore";

export function pauseStoppedAutomationTurn(id: string) {
  const loop = getChatLoops(id).find((item) => item.pending);
  if (loop?.pending) {
    const store = useChatLoopStore.getState();
    store.update(id, loop.id, { pending: { ...loop.pending, stopped: true } });
    store.pause(id, loop.id);
    return;
  }
  const goal = getChatGoal(id);
  if (!goal?.pendingMessageId) return;
  const user = useChatStore
    .getState()
    .messagesBySession[id]?.find((m) => m.id === goal.pendingMessageId);
  if (
    user?.metadata?.distillDeliveryId ===
    goalTurnDeliveryId(goal.id, goal.turns)
  )
    useChatGoalStore.getState().pause(id, copy("operatorStopped"));
}
