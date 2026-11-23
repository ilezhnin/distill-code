import { GOAL_REPORT_PREFIX } from "./automationProtocol";
import { automationCopy as copy } from "./automationCopy";
import {
  useChatStore,
  type QueuedMessageRecord,
} from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";

import { QueuedSessionNotReadyError } from "@/features/chat/lib/queuedMessageReadiness";
import {
  automationGuardsReady,
  prepareAutomationGuards,
  automationWithheld,
  automationQueueIdle,
  roadmapActive,
} from "./automationReadiness";
import {
  getSessionDispatchTarget,
  onSessionDispatchReleased,
} from "@/features/chat/lib/sessionTargetCoordinator";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import { useMemoryStore } from "@/features/memory/stores/memoryStore";
import { subscribeWaveEngineState } from "@/features/conductor/waveStore";
import { isWaveExecutorSession } from "@/features/memory/lib/memoryWriteAccess";
import {
  automationNotice as notice,
  automationTransitionNotice,
  withCommandNotice,
  enqueueAutomationTurn,
  reportAutomationTransition,
} from "./automationQueue";
import {
  dueLoop,
  tickChatLoops,
  nextLoopWake,
  notifyLoopTransition,
  settleLoopTurn,
} from "./loopRuntime";
import { useChatLoopStore, onLoopTransition, getChatLoops } from "./loopStore";
import { isRecord } from "@/shared/lib/isRecord";
import {
  getTextContent,
  type Message,
  type MessageMetadata,
} from "@/shared/types/messages";
import {
  goalPrompt,
  goalReply,
  goalTurnDeliveryId,
  parseGoalCommand,
} from "./commands";
import {
  getChatGoal,
  goalCounters,
  hydrateChatGoals,
  useChatGoalStore,
  type ChatGoal,
} from "./goalStore";

function describe(id: string, goal: ChatGoal) {
  const { turns, tokens, elapsedMs } = goalCounters(id, goal);
  return [
    copy(`goalStatus.${goal.status}`, { objective: goal.objective }),
    copy("usage", { turns, tokens, elapsed: Math.floor(elapsedMs / 1000) }),
    goal.note,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function prepareGoalDispatch() {
  await hydrateChatGoals();
  await prepareAutomationGuards();
}

export function handleGoalCommand(
  id: string,
  args: string,
  metadata?: Partial<MessageMetadata>,
) {
  const store = useChatGoalStore.getState();
  const before = getChatGoal(id);
  const parsed = parseGoalCommand(args);
  let result: string;
  if (!automationGuardsReady()) result = copy("loading");
  else if (isWaveExecutorSession(id)) result = copy("workerGoal");
  else if (parsed.action === "invalid") result = parsed.reason;
  else if (parsed.action === "set" && roadmapActive(id))
    result = copy("roadmap");
  else if (parsed.action === "set") {
    store.start(id, parsed.objective, parsed.maxTurns, parsed.budget);
    result = copy(before ? "goalReplaced" : "goalSet", {
      objective: parsed.objective,
    });
  } else if (!before) result = copy("noGoal");
  else {
    withCommandNotice(id, () => {
      switch (parsed.action) {
        case "pause":
          store.pause(id);
          break;
        case "resume":
          store.resume(id);
          break;
        case "clear":
          store.clear(id);
          break;
      }
    });
    const after = getChatGoal(id);
    result = after ? describe(id, after) : copy("cleared");
  }
  notice(id, result, metadata);
}

function limitReason(id: string, goal: ChatGoal) {
  if (goal.turns - goal.turnsAtResume >= goal.maxTurns)
    return copy("turnCap", { cap: goal.maxTurns });
  if (
    goal.budget &&
    goalCounters(id, goal).tokens - goal.tokensBeforeResume >= goal.budget
  )
    return copy("tokenCap", { budget: goal.budget });
  return null;
}

export function beginGoalTurn(
  id: string,
  messageId: string,
  automated: boolean,
) {
  const goal = getChatGoal(id);
  if (goal?.status !== "active") return;
  useChatGoalStore.getState().update(id, {
    pendingMessageId: messageId,
    turns: goal.turns + Number(automated),
  });
}

export function rollbackGoalTurn(
  id: string,
  messageId: string,
  automated: boolean,
) {
  const goal = getChatGoal(id);
  if (goal?.pendingMessageId === messageId) {
    useChatGoalStore.getState().update(id, {
      pendingMessageId: undefined,
      turns: goal.turns - Number(automated),
    });
  }
}

export function settleGoalTurn(
  id: string,
  messageId: string,
  failure?: string,
) {
  const goal = getChatGoal(id);
  if (goal?.status !== "active" || goal.pendingMessageId !== messageId) return;
  const messages = useChatStore.getState().messagesBySession[id] ?? [];
  const start = messages.findIndex((m) => m.id === messageId);
  const reply =
    start < 0
      ? undefined
      : messages
          .slice(start + 1)
          .filter((m) => m.role === "assistant")
          .at(-1);
  finishGoalReply(id, reply, failure);
}

// Host-owned follow-up turns can settle without a local dispatch promise.
export function finishGoalReply(id: string, reply?: Message, failure?: string) {
  const pendingLoop = getChatLoops(id).find((loop) => loop.pending)?.pending;
  if (pendingLoop) {
    settleLoopTurn(id, pendingLoop.messageId, failure);
    return;
  }
  const goal = getChatGoal(id);
  if (goal?.status !== "active") return;
  const state = reply && goalReply(getTextContent(reply));
  const store = useChatGoalStore.getState();
  const reason =
    failure ||
    reply?.metadata?.failureReason ||
    (reply?.metadata?.completionStatus === "error"
      ? copy("providerFailed")
      : undefined);
  if (reason) store.pause(id, reason);
  else if (state?.status === "reached") store.reach(id, state.note);
  else if (state?.status === "blocked") store.pause(id, state.note);
  else {
    const limit = limitReason(id, goal);
    if (limit) store.pause(id, limit);
    else
      store.update(id, {
        pendingMessageId: undefined,
        note: state?.note ?? "",
      });
  }
}

export function queuedGoalId(record: QueuedMessageRecord) {
  return record.payload.sendOptions?.acpPromptMetadata?.flockGoalId;
}

function queueAutomatedTurn(
  id: string,
  text: string,
  deliveryId: string,
  goalId?: string,
) {
  enqueueAutomationTurn(id, text, {
    senderLabel: copy("sender.goal"),
    deliveryId,
    metadata: goalId ? { flockGoalId: goalId } : undefined,
  });
}

// The queue may have changed, or a hold may have landed, during ACP preparation.
export function assertGoalDispatch(id: string, goalId: unknown) {
  if (goalId === undefined) return;
  const goal = getChatGoal(id);
  const queue = useChatStore.getState().queuedMessageBySession[id] ?? [];
  if (
    goal?.id !== goalId ||
    goal?.status !== "active" ||
    goal.pendingMessageId ||
    limitReason(id, goal) ||
    automationWithheld(id) ||
    roadmapActive(id) ||
    dueLoop(id) ||
    queue.length !== 1 ||
    queuedGoalId(queue[0]) !== goalId
  ) {
    // The automation owns this queued intent. Withdrawing just its stale
    // record frees the operator's head even if the goal was already cleared.
    const record = queue.find((item) => queuedGoalId(item) === goalId);
    if (record)
      useChatStore.getState().dismissQueuedMessage(id, record.recordId);
    throw new QueuedSessionNotReadyError();
  }
}

export function tickChatGoal(id: string) {
  const goal = getChatGoal(id);
  const chat = useChatStore.getState();
  const sessions = useChatSessionStore.getState();
  if (!chat.hasHydratedMessageQueues || !sessions.hasHydratedSessions) return;
  const queue = chat.queuedMessageBySession[id] ?? [];
  if (goal?.status !== "active" && !queue.some(queuedGoalId)) return;
  const withheld =
    automationWithheld(id) || roadmapActive(id) || Boolean(dueLoop(id));
  for (const record of queue) {
    const owner = queuedGoalId(record);
    if (!owner) continue;
    if (
      record.kind === "deferred" &&
      goal?.id === owner &&
      goal.status === "active"
    ) {
      useChatGoalStore
        .getState()
        .pause(
          id,
          isRecord(record.state) && record.state.error
            ? String(record.state.error)
            : copy("goalFailed"),
        );
      return;
    }
    if (
      record.kind === "deferred" &&
      goal?.id === owner &&
      goal.status === "paused"
    )
      continue;
    if (
      goal?.id !== owner ||
      goal?.status !== "active" ||
      withheld ||
      queue.length > 1
    ) {
      chat.dismissQueuedMessage(id, record.recordId);
    }
  }
  if (
    withheld ||
    goal?.status !== "active" ||
    goal.pendingMessageId ||
    !automationQueueIdle(id)
  )
    return;
  const limit = limitReason(id, goal);
  if (limit) useChatGoalStore.getState().pause(id, limit);
  else
    queueAutomatedTurn(
      id,
      goalPrompt(goal.objective),
      goalTurnDeliveryId(goal.id, goal.turns + 1),
      goal.id,
    );
}

export function startChatAutomation(recovering = new Set<string>()) {
  return startRecoverableAutomation(recovering).dispose;
}

export function startRecoverableAutomation(recovering: Set<string>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scheduled = false;
  let disposed = false;
  function wake() {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (disposed) return;
      clearTimeout(timer);
      let deadline = Infinity;
      const passStarted = Date.now();
      const ids = new Set([
        ...Object.keys(useChatGoalStore.getState().goals),
        ...Object.keys(useChatLoopStore.getState().loops),
      ]);
      for (const id of ids) {
        if (recovering.has(id)) continue;
        // A foreground or CLI send can own the target before the chat shows
        // its turn. Wake at lease release, even if its preparation failed.
        if (getSessionDispatchTarget(id)) onSessionDispatchReleased(id, wake);
        tickChatLoops(id);
        tickChatGoal(id);
        deadline = Math.min(deadline, nextLoopWake(id, passStarted));
      }
      if (Number.isFinite(deadline))
        timer = setTimeout(wake, Math.max(1, deadline - Date.now()));
    });
  }
  const subscriptions = [
    useChatStore.subscribe((state, previous) => {
      if (
        state.hasHydratedMessageQueues !== previous.hasHydratedMessageQueues ||
        state.queuedMessageBySession !== previous.queuedMessageBySession ||
        state.sessionStateById !== previous.sessionStateById
      )
        wake();
    }),
    onLoopTransition(notifyLoopTransition),
    useChatLoopStore.subscribe((state, previous) => {
      for (const id of Object.keys(previous.loops)) {
        if (!state.loops[id]) tickChatLoops(id);
      }
      wake();
    }),
    useChatSessionStore.subscribe(wake),
    subscribeWaveEngineState(wake),
    useMemoryStore.subscribe(wake),
    useConductorGraphStore.subscribe(wake),
    useChatGoalStore.subscribe((state, previous) => {
      for (const [id, old] of Object.entries(previous.goals)) {
        const goal = state.goals[id];
        if (old === goal) continue;
        if (old.status === "paused" && goal?.status === "active") {
          if (goal.id === old.id)
            automationTransitionNotice(id, describe(id, goal));
          const chat = useChatStore.getState();
          for (const record of chat.queuedMessageBySession[id] ?? []) {
            if (record.kind === "deferred" && queuedGoalId(record) === old.id)
              chat.dismissQueuedMessage(id, record.recordId);
          }
        }
        if (
          old.status === "active" &&
          (goal?.id !== old.id || goal.status !== "active")
        ) {
          const summary =
            goal?.id === old.id
              ? describe(id, goal)
              : copy("goalEnded", { objective: old.objective });
          reportAutomationTransition(
            id,
            summary,
            copy("sender.goal"),
            `${GOAL_REPORT_PREFIX}${old.id}:${old.resumedAt}`,
            goal?.status === "reached" ? "completed" : "blocked",
          );
          if (goal?.id === old.id) automationTransitionNotice(id, summary);
        }
        if (!goal) {
          const session = useChatSessionStore.getState().getSession(id);
          if (session && !session.archivedAt)
            automationTransitionNotice(id, copy("cleared"));
          tickChatGoal(id);
        }
      }
      wake();
    }),
  ];
  wake();
  function dispose() {
    disposed = true;
    clearTimeout(timer);
    for (const unsubscribe of subscriptions) unsubscribe();
  }
  return { wake, dispose };
}
