/**
 * Every notice the app posts in a conductor's chat reaches the conductor too.
 *
 * A notice is written for the operator: it sits in the transcript with
 * `agentVisible: false`, so the conductor's model never saw it. On 2026-11-08
 * the Producer conductor named a model the app had already warned was near
 * its limit, the steps stalled on the spent allowance, and the conductor
 * learned of the warnings only when the operator asked why it had ignored
 * them. A conductor plans from what it knows; what the app knows about its
 * waves it has to know as well (LAWS/WAVES.md, Transparency).
 *
 * One watcher over the chat store rather than a call at every place a notice
 * is written, so a notice added anywhere — now or later — cannot be missed.
 * Notices are gathered for a moment and sent as one message:
 *
 * - while the conductor works, steered into its turn (queued behind it when
 *   the provider cannot steer);
 * - while it is idle, a warning or an error is delivered at once, as a turn —
 *   it may change the plan, and nothing else would wake the conductor for it;
 * - an informational notice alone does not wake an idle conductor: it waits
 *   for the next time the conductor works, or rides with the next warning.
 */

import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import { steerPromptInSession } from "@/features/chat/lib/steerCore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { flockctlCrossSessionSendOptions } from "@/features/flockctl/commands/runtime/sessionSend";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { i18n } from "@/shared/i18n";
import {
  createSystemNotificationMessage,
  type Message,
  type SystemNotificationContent,
} from "@/shared/types/messages";
import { BoundedSet } from "./boundedSet";
import { isConductorSession } from "./conductorGraphStore";
import { deliverEnvelope } from "./digestDelivery";

/** How long notices gather before they go out together. */
export const CONDUCTOR_NOTICE_RELAY_DELAY_MS = 2_500;

/** The most notices one relay message carries; older ones are counted. */
const MAX_NOTICES_PER_RELAY = 20;

/** The longest a single notice may be inside a relay message. */
const MAX_NOTICE_LENGTH = 1_500;

type RelayedType = "info" | "warning" | "error";

export interface RelayedNotice {
  id: string;
  at: number;
  type: RelayedType;
  text: string;
}

const pendingBySession = new Map<string, RelayedNotice[]>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Set<string>();
const seenNoticeIds = new BoundedSet(5_000);
const skippedNoticeIds = new BoundedSet(1_000);
let lastMessagesBySession: Readonly<Record<string, readonly Message[]>> = {};
let relayStartedAt = Date.now();

/**
 * Keeps one notice from being relayed: one that restates, after a restart,
 * what the conductor was already told, or one about the relay itself.
 */
export function skipConductorNoticeRelay(messageId: string): void {
  skippedNoticeIds.add(messageId);
}

function relayableNotice(message: Message): RelayedNotice | null {
  if (message.role !== "system") return null;
  if (message.metadata?.agentVisible !== false) return null;
  if (message.created < relayStartedAt) return null;
  if (seenNoticeIds.has(message.id) || skippedNoticeIds.has(message.id)) {
    return null;
  }
  const content = message.content.find(
    (part): part is SystemNotificationContent =>
      part.type === "systemNotification",
  );
  if (!content || content.notificationType === "compaction") return null;
  const text = content.text.trim();
  if (!text) return null;
  return {
    id: message.id,
    at: message.created,
    type: content.notificationType,
    text,
  };
}

/** The message a batch of notices reaches the conductor as. */
export function buildConductorNoticeRelay(
  notices: readonly RelayedNotice[],
): string {
  const shown = notices.slice(-MAX_NOTICES_PER_RELAY);
  const dropped = notices.length - shown.length;
  const lines = shown.map((notice) => {
    const time = new Date(notice.at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    const text =
      notice.text.length > MAX_NOTICE_LENGTH
        ? `${notice.text.slice(0, MAX_NOTICE_LENGTH - 1)}…`
        : notice.text;
    return `- ${time} (${notice.type}) ${text.replace(/\n+/g, " ")}`;
  });
  return [
    "[flock-notice]",
    "Notices the Flock app just showed the operator in this chat. You get them too, so you have the same picture. This is not a digest: do not emit a distill-verdict for it. Act on a notice where it changes your plan — a model at or near its limit, a step the app could not start or had to stop, a wave parked for the operator — and otherwise carry on with what you were doing.",
    "",
    ...(dropped > 0
      ? [`(${dropped} earlier notices of this batch are not repeated here.)`]
      : []),
    ...lines,
  ].join("\n");
}

function conductorRunning(sessionId: string): boolean {
  const runtime = useChatStore.getState().sessionStateById[sessionId];
  return Boolean(runtime && isSessionRunning(runtime.chatState));
}

function scheduleFlush(sessionId: string, delayMs: number): void {
  if (timers.has(sessionId)) return;
  timers.set(
    sessionId,
    setTimeout(() => {
      timers.delete(sessionId);
      void flushConductorNotices(sessionId);
    }, delayMs),
  );
}

function reportUndelivered(sessionId: string, count: number, detail: string) {
  const message = createSystemNotificationMessage(
    i18n.t("chat:conductor.noticeRelay.undelivered", { count, detail }),
    "warning",
  );
  skipConductorNoticeRelay(message.id);
  useChatStore.getState().addMessage(sessionId, message);
}

/**
 * Sends what has gathered for one conductor, by the rules at the top of this
 * file. Exported for tests; the watcher calls it on its timer.
 */
export async function flushConductorNotices(sessionId: string): Promise<void> {
  if (inFlight.has(sessionId)) {
    scheduleFlush(sessionId, CONDUCTOR_NOTICE_RELAY_DELAY_MS);
    return;
  }
  // The watcher picks a notice up inside the store write that adds it, before
  // its writer can mark it as not for relaying; the mark is read here.
  const notices = pendingBySession
    .get(sessionId)
    ?.filter((notice) => !skippedNoticeIds.has(notice.id));
  if (!notices?.length) {
    pendingBySession.delete(sessionId);
    return;
  }
  pendingBySession.set(sessionId, notices);
  const running = conductorRunning(sessionId);
  const urgent = notices.some((notice) => notice.type !== "info");
  // Informational notices alone wait for the conductor's next turn; the
  // watcher flushes them as soon as it sees that turn start.
  if (!running && !urgent) return;
  pendingBySession.delete(sessionId);
  const text = buildConductorNoticeRelay(notices);
  inFlight.add(sessionId);
  try {
    if (running) {
      let delivery: string | undefined;
      const accepted = await steerPromptInSession(
        sessionId,
        text,
        undefined,
        flockctlCrossSessionSendOptions({ senderLabel: "Flock" }),
        {
          queueIfUnavailable: true,
          onDelivery: (value) => {
            delivery = value;
          },
        },
      );
      if (!accepted || delivery === "steer_failed") {
        // The turn ended under the steer: deliver it as its own message.
        const result = await deliverEnvelope(sessionId, text);
        if (result.status === "failed") {
          reportUndelivered(sessionId, notices.length, result.detail ?? "");
        }
      }
      return;
    }
    const result = await deliverEnvelope(sessionId, text);
    if (result.status === "failed") {
      reportUndelivered(sessionId, notices.length, result.detail ?? "");
    }
  } catch (error) {
    reportUndelivered(sessionId, notices.length, formatAcpErrorMessage(error));
  } finally {
    inFlight.delete(sessionId);
  }
}

/**
 * One pass over the chat store: picks up every new notice in a conductor's
 * chat, and flushes informational notices whose conductor has started work.
 */
export function collectConductorNotices(
  messagesBySession: Readonly<Record<string, readonly Message[]>>,
): void {
  const previous = lastMessagesBySession;
  lastMessagesBySession = messagesBySession;
  for (const sessionId in messagesBySession) {
    const messages = messagesBySession[sessionId];
    const before = previous[sessionId];
    if (!messages || messages === before) continue;
    if (!isConductorSession(sessionId)) continue;
    // Notices are appended. Re-reading the last message already seen covers
    // a store write that replaced it in the same breath; a shorter array is
    // a reload, read whole — the seen set keeps it from sending twice.
    const start =
      before && messages.length >= before.length
        ? Math.max(0, before.length - 1)
        : 0;
    let found = false;
    for (let index = start; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message) continue;
      const notice = relayableNotice(message);
      if (!notice) continue;
      seenNoticeIds.add(notice.id);
      const queue = pendingBySession.get(sessionId) ?? [];
      queue.push(notice);
      pendingBySession.set(sessionId, queue);
      found = true;
    }
    if (found) scheduleFlush(sessionId, CONDUCTOR_NOTICE_RELAY_DELAY_MS);
  }
}

/** Flushes held informational notices of conductors that started a turn. */
export function flushNoticesOfWorkingConductors(): void {
  for (const sessionId of pendingBySession.keys()) {
    if (conductorRunning(sessionId)) scheduleFlush(sessionId, 0);
  }
}

/** Starts watching. Returns the function that stops it. */
export function startConductorNoticeRelay(): () => void {
  lastMessagesBySession = useChatStore.getState().messagesBySession;
  const unsubMessages = useChatStore.subscribe(
    (state) => state.messagesBySession,
    collectConductorNotices,
  );
  const unsubRuntimes = useChatStore.subscribe(
    (state) => state.sessionStateById,
    flushNoticesOfWorkingConductors,
  );
  return () => {
    unsubMessages();
    unsubRuntimes();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}

export function resetConductorNoticeRelayForTests(startedAt = 0): void {
  pendingBySession.clear();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  inFlight.clear();
  lastMessagesBySession = {};
  relayStartedAt = startedAt;
}
