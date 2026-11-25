/**
 * The notice a chat gets when a reply holds a protocol block the app did not
 * read.
 *
 * The reader takes a block only where the transcript shows it as one of the
 * reply's own blocks, and that is right: a plan quoted from a brief must not
 * start a wave. But a conductor that pasted a document holding its own code
 * block, and wrote its plan below it, sees its plan swallowed by that block
 * and believes it launched a wave; the operator sees a quoted plan and a wave
 * that never starts. Both used to be told nothing. One notice per reply now
 * names the block and why it was not read, in the chat it belongs to.
 *
 * Only replies written while this app runs are announced: the scanners read
 * old transcripts again after every restart, and a notice for each old reply
 * — with a request to the conductor behind each plan — would arrive in a
 * burst nobody asked for.
 */

import { BoundedSet } from "@/features/conductor/boundedSet";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { i18n } from "@/shared/i18n";
import type { UnreadProtocolBlockReason } from "@/shared/lib/protocolFences";
import { createSystemNotificationMessage } from "@/shared/types/messages";

/** The protocols whose unread blocks are announced. */
export type UnreadProtocolBlockKind = "plan" | "roadmap" | "memory" | "recall";

/** What became of the request to send an unread plan again. */
export type UnreadPlanFollowUp = "asked" | "askedBefore" | "onHold";

let noticesSince = Date.now();
let announced = new BoundedSet(2_000);

/** The text of the notice, in the operator's language. */
export function unreadProtocolBlockNoticeText(
  kind: UnreadProtocolBlockKind,
  reason: UnreadProtocolBlockReason,
  followUp?: UnreadPlanFollowUp,
): string {
  const lines = [
    i18n.t("chat:protocolBlock.unread", {
      kind: i18n.t(`chat:protocolBlock.kind.${kind}`),
      reason: i18n.t(`chat:protocolBlock.reason.${reason}`),
    }),
  ];
  if (followUp === "asked") lines.push(i18n.t("chat:protocolBlock.planAsked"));
  if (followUp === "askedBefore") {
    lines.push(i18n.t("chat:protocolBlock.planAskedBefore"));
  }
  if (followUp === "onHold") {
    lines.push(i18n.t("chat:protocolBlock.planOnHold"));
  }
  return lines.join(" ");
}

/** The notice for a request to send a plan again that never arrived. */
export function unreadPlanAskFailedText(detail: string): string {
  return i18n.t("chat:protocolBlock.planAskFailed", { detail });
}

/**
 * Posts the notice for one reply, once. Returns the notice's message id, or
 * `null` when the reply predates this app's start or was announced already,
 * so a caller that follows the notice with a request sends it only once too.
 */
export function announceUnreadProtocolBlock(args: {
  sessionId: string;
  /** The reply that holds the block. */
  messageId: string;
  /** When that reply was written. */
  created: number;
  kind: UnreadProtocolBlockKind;
  reason: UnreadProtocolBlockReason;
  followUp?: UnreadPlanFollowUp;
  type?: "info" | "warning";
}): string | null {
  if (args.created < noticesSince) return null;
  if (announced.has(args.messageId)) return null;
  announced.add(args.messageId);
  const message = createSystemNotificationMessage(
    unreadProtocolBlockNoticeText(args.kind, args.reason, args.followUp),
    args.type ?? "info",
  );
  useChatStore.getState().addMessage(args.sessionId, message);
  return message.id;
}

/** Forgets what was announced, and announces replies from `since` on. Tests only. */
export function resetUnreadProtocolBlockNoticesForTests(since = 0): void {
  noticesSince = since;
  announced = new BoundedSet(2_000);
}
