import { LOOP_REPORT_PREFIX } from "./automationProtocol";
import { formatDate } from "@/shared/i18n/format";
import { automationCopy as copy } from "./automationCopy";
import {
  useChatStore,
  type QueuedMessageRecord,
} from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { QueuedSessionNotReadyError } from "@/features/chat/lib/queuedMessageReadiness";
import { buildSkillSendPayload } from "@/features/chat/lib/skillSendPayload";
import { getWorkspaceRepository } from "@/features/workspaces/workspaceRepository";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { listSkills } from "@/features/skills/api/skills";
import { resolveSkillSlashCommand } from "@/features/skills/lib/skillChatPrompt";
import { isWaveExecutorSession } from "@/features/memory/lib/memoryWriteAccess";
import {
  getTextContent,
  type Message,
  type MessageMetadata,
} from "@/shared/types/messages";
import { isRecord } from "@/shared/lib/isRecord";
import { getChatGoal } from "./goalStore";
import {
  automationGuardsReady,
  automationQueueIdle,
  automationWithheld,
  prepareAutomationGuards,
} from "./automationReadiness";
import {
  automationNotice,
  automationTransitionNotice,
  withCommandNotice,
  enqueueAutomationTurn,
  reportAutomationTransition,
} from "./automationQueue";
import {
  MIN_DELAY,
  DEFAULT_LOOP_DELAY,
  MAX_CHAT_LOOPS,
  LOOP_TURN_PREFIX,
  loopPrompt,
  loopReply,
  parseLoopCommand,
} from "./loopCommands";
import {
  type ChatLoop,
  getChatLoop,
  getChatLoops,
  hydrateChatLoops,
  loopCounters,
  loopExpiry,
  loopSessionTokens,
  useChatLoopStore,
} from "./loopStore";

const dateOptions = { dateStyle: "short", timeStyle: "short" } as const;

export async function prepareLoopDispatch() {
  await hydrateChatLoops();
  await prepareAutomationGuards();
}

export function handleLoopCommand(
  id: string,
  args: string,
  metadata?: Partial<MessageMetadata>,
) {
  const command = parseLoopCommand(args);
  const loops = getChatLoops(id);
  const store = useChatLoopStore.getState();
  let result: string;
  if (!automationGuardsReady()) result = copy("loading");
  else if (isWaveExecutorSession(id)) result = copy("workerLoop");
  else if (command.action === "invalid") result = command.reason;
  else if (command.action === "create") {
    const loop = store.start(id, command.prompt, command.intervalMs);
    result = loop
      ? [
          copy("loopCreated", { number: loop.number, prompt: command.prompt }),
          command.raised &&
            copy("intervalRaised", { seconds: MIN_DELAY / 1000 }),
        ]
          .filter(Boolean)
          .join("\n")
      : copy("loopCap", { cap: MAX_CHAT_LOOPS });
  } else if (!loops.length) result = copy("noLoops");
  else if (command.action === "list")
    result = loops
      .map((loop) => {
        const { tokens, nextRunAt, expiresAt } = loopCounters(id, loop);
        return [
          copy(`loopStatus.${loop.status}`, {
            number: loop.number,
            prompt: loop.prompt,
          }),
          copy("loopUsageStats", { runs: loop.runs, tokens }),
          copy("deadline", {
            next:
              nextRunAt === null
                ? copy("unscheduled")
                : nextRunAt >= expiresAt
                  ? copy("afterExpiry")
                  : formatDate(nextRunAt, dateOptions),
            expiry: formatDate(expiresAt, dateOptions),
          }),
        ].join("\n");
      })
      .join("\n");
  else {
    const targets = loops.filter(
      (loop) => command.number === undefined || loop.number === command.number,
    );
    withCommandNotice(id, () => {
      for (const loop of targets) store[command.action](id, loop.id);
    });
    result = targets.length
      ? copy(`loopControl.${command.action}`, {
          numbers: targets.map((loop) => loop.number).join(", "),
        })
      : copy("noNumber", { number: command.number });
  }
  automationNotice(id, result, metadata);
}

export function notifyLoopTransition(
  id: string,
  loop: ChatLoop,
  status: "paused" | "resumed" | "ended",
  reason: string,
) {
  if (status === "resumed") {
    automationTransitionNotice(
      id,
      copy("loopControl.resume", { numbers: String(loop.number) }),
    );
    return;
  }
  const summary = [
    copy(`loopTransition.${status}`, { number: loop.number, reason }),
    loop.prompt,
    copy("loopUsageStats", {
      runs: loop.runs,
      tokens: loopCounters(id, loop).tokens,
    }),
  ].join("\n");
  const session = useChatSessionStore.getState().getSession(id);
  if (session && !session.archivedAt) automationTransitionNotice(id, summary);
  reportAutomationTransition(
    id,
    summary,
    copy("sender.loop"),
    `${LOOP_REPORT_PREFIX}${loop.id}:${crypto.randomUUID()}`,
    status === "paused" ? "blocked" : "completed",
  );
}

export function dueLoop(id: string, now = Date.now()) {
  // Oldest deadline wins so a long-running loop cannot starve its siblings.
  return getChatLoops(id)
    .filter(
      (loop) =>
        loop.status === "active" &&
        !loop.pending &&
        loop.nextRunAt !== null &&
        loop.nextRunAt <= now &&
        loopExpiry(loop) > now,
    )
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0];
}

export function nextLoopWake(id: string, now = Date.now()) {
  let next = Infinity;
  for (const loop of getChatLoops(id)) {
    if (loopExpiry(loop) > now) next = Math.min(next, loopExpiry(loop));
    if (
      loop.status === "active" &&
      loop.nextRunAt !== null &&
      loop.nextRunAt > now
    )
      next = Math.min(next, loop.nextRunAt);
  }
  return next;
}

const queuedLoopId = (record: QueuedMessageRecord) =>
  record.payload.sendOptions?.acpPromptMetadata?.flockLoopId;
export const loopDeliveryId = (loop: ChatLoop, run = loop.runs + 1) =>
  `${LOOP_TURN_PREFIX}${loop.id}:${run}`;

export function tickChatLoops(id: string) {
  const chat = useChatStore.getState();
  if (
    !chat.hasHydratedMessageQueues ||
    !useChatSessionStore.getState().hasHydratedSessions
  )
    return;
  const store = useChatLoopStore.getState();
  for (const loop of getChatLoops(id)) {
    if (loopExpiry(loop) <= Date.now())
      store.stop(id, loop.id, copy("expired"));
  }
  const due = dueLoop(id);
  const withheld = automationWithheld(id);
  const queue = chat.queuedMessageBySession[id] ?? [];
  for (const record of queue) {
    const owner = queuedLoopId(record);
    if (!owner) continue;
    const loop = getChatLoop(id, owner);
    const receipt =
      record.payload.sendOptions?.userMessageMetadata?.distillDeliveryId;
    // The drain owns this record until the host acknowledges the started turn.
    if (loop?.pending && receipt === loopDeliveryId(loop, loop.runs)) continue;
    const expected = loop && receipt === loopDeliveryId(loop);
    if (expected && record.kind === "deferred" && loop.status === "active") {
      const reason =
        isRecord(record.state) && record.state.error
          ? String(record.state.error)
          : copy("loopFailed");
      const next =
        fixedNext(loop, Date.now()) ?? Date.now() + DEFAULT_LOOP_DELAY;
      store.update(id, loop.id, { runs: loop.runs + 1, nextRunAt: next });
      recordFailure(id, loop, reason);
      continue;
    }
    // A failed queue head stays visible. Withdraw our failed intent only
    // when another message needs the slot or its owner ends the loop.
    if (
      record.kind === "deferred" &&
      loop &&
      receipt === loopDeliveryId(loop, loop.runs) &&
      queue.length === 1 &&
      (withheld || (!due && getChatGoal(id)?.status !== "active"))
    )
      continue;
    if (
      !expected ||
      record.kind === "deferred" ||
      due?.id !== owner ||
      withheld ||
      queue.length > 1
    )
      chat.dismissQueuedMessage(id, record.recordId);
  }
  if (withheld || !due || queue.length || !automationQueueIdle(id)) return;
  enqueueAutomationTurn(id, loopPrompt(due.prompt, !due.intervalMs), {
    senderLabel: copy("sender.loop"),
    deliveryId: loopDeliveryId(due),
    metadata: { flockLoopId: due.id },
  });
}

export function assertLoopDispatch(
  id: string,
  loopId: string,
  deliveryId?: string,
) {
  const loop = dueLoop(id);
  const queue = useChatStore.getState().queuedMessageBySession[id] ?? [];
  if (
    loop?.id === loopId &&
    loopDeliveryId(loop) === deliveryId &&
    !automationWithheld(id) &&
    queue.length === 1 &&
    queuedLoopId(queue[0]) === loopId
  )
    return;
  const stale = queue.find(
    (item) =>
      queuedLoopId(item) === loopId &&
      item.payload.sendOptions?.userMessageMetadata?.distillDeliveryId ===
        deliveryId,
  );
  if (stale) useChatStore.getState().dismissQueuedMessage(id, stale.recordId);
  throw new QueuedSessionNotReadyError();
}

export async function resolveLoopSkill(
  id: string,
  loopId: string,
  providerId?: string,
) {
  const loop = getChatLoop(id, loopId);
  if (!loop?.prompt.startsWith("/")) return;
  const session = useChatSessionStore.getState().getSession(id);
  const workspace = getWorkspaceRepository();
  const paths =
    workspace.mode === "multi"
      ? workspace.chatWorkspaces(session).workspaces.map((item) => item.path)
      : (useProjectStore
          .getState()
          .projects.find((project) => project.id === session?.projectId)
          ?.workingDirs ?? []);
  const skills = await listSkills(paths, { providerId });
  const match = resolveSkillSlashCommand(loop.prompt, skills);
  if (!match) return;
  const { messageText, sendOptions } = buildSkillSendPayload(
    loop.prompt,
    [],
    match,
    { providerId },
  );
  return {
    text: messageText.trim() || match.promptText,
    sendOptions,
  };
}

function fixedNext(loop: ChatLoop, now: number) {
  if (!loop.intervalMs) return null;
  const elapsed = Math.max(0, now - loop.createdAt);
  return (
    loop.createdAt +
    (Math.floor(elapsed / loop.intervalMs) + 1) * loop.intervalMs
  );
}

export function beginLoopTurn(
  id: string,
  loop: ChatLoop,
  messageId: string,
  now = Date.now(),
) {
  useChatLoopStore.getState().update(id, loop.id, {
    runs: loop.runs + 1,
    nextRunAt: fixedNext(loop, now),
    pending: {
      messageId,
      ledgerBefore: loopSessionTokens(id),
      dueAt: loop.nextRunAt ?? now,
    },
  });
}

export function rollbackLoopTurn(id: string, loop: ChatLoop) {
  if (!loop.pending) return;
  useChatLoopStore.getState().update(id, loop.id, {
    runs: loop.runs - 1,
    pending: undefined,
    nextRunAt: loop.pending.dueAt,
  });
}

function recordFailure(id: string, loop: ChatLoop, reason: string) {
  const failures = loop.failures + 1;
  const store = useChatLoopStore.getState();
  store.update(id, loop.id, { failures, note: reason });
  if (failures >= 3)
    store.pause(id, loop.id, copy("threeFailures", { reason }));
}

export function settleLoopTurn(
  id: string,
  messageId: string,
  failure?: string,
  recovering = false,
) {
  const loop = getChatLoops(id).find(
    (item) => item.pending?.messageId === messageId,
  );
  if (!loop) return;
  const messages = useChatStore.getState().messagesBySession[id] ?? [];
  const start = messages.findIndex((m) => m.id === messageId);
  let reply: Message | undefined;
  for (let i = start + 1; start >= 0 && i < messages.length; i++) {
    if (
      messages[i].role === "user" &&
      messages[i].metadata?.delivery !== "steering"
    )
      break;
    if (messages[i].role === "assistant") reply = messages[i];
  }
  const state = loopReply(reply ? getTextContent(reply) : "");
  const reason =
    failure ||
    reply?.metadata?.failureReason ||
    (reply?.metadata?.completionStatus === "error"
      ? copy("providerFailed")
      : undefined);
  const store = useChatLoopStore.getState();
  // On replay use the recorded reply time so an already overdue self-paced
  // loop receives the same single catch-up turn as a fixed-interval loop.
  const completedAt = recovering && reply ? reply.created : Date.now();
  store.update(id, loop.id, {
    pending: undefined,
    tokens: loopCounters(id, loop).tokens,
    nextRunAt: loop.pending?.stopped
      ? loop.nextRunAt
      : loop.status === "paused"
        ? null
        : loop.intervalMs
          ? loop.nextRunAt
          : completedAt +
            (!reason && !state.done ? state.delay : DEFAULT_LOOP_DELAY),
  });
  if (loop.status !== "active" || loop.pending?.stopped) return;
  if (reason) recordFailure(id, loop, reason);
  else if (state.done) store.stop(id, loop.id, state.note);
  else store.update(id, loop.id, { failures: 0, note: "" });
}
