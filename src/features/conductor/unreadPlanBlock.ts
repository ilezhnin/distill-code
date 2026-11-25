/**
 * A conductor reply that holds a wave plan the reader did not take.
 *
 * The plan is not run: the transcript shows it inside a quote, a list or
 * another block, and a plan the conductor only quoted must never start a
 * wave. But the conductor may have meant it — the usual case is a plan
 * written under a pasted document whose own code block swallowed it — so it
 * is asked once, as its next turn, to send the plan again on its own. The
 * operator sees one notice that says what happened.
 *
 * Once, and never in a loop: the answer to that request is not asked again,
 * whatever it holds, until the operator has spoken. Q2's rule that a refused
 * plan is retried only on the operator's word still holds for plans that
 * were read and refused; this one was never read.
 */

import {
  announceUnreadProtocolBlock,
  unreadPlanAskFailedText,
  type UnreadPlanFollowUp,
} from "@/features/chat/lib/unreadProtocolBlockNotice";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  type UnreadProtocolBlockReason,
  unreadProtocolBlockPlace,
} from "@/shared/lib/protocolFences";
import {
  createSystemNotificationMessage,
  getTextContent,
  type Message,
} from "@/shared/types/messages";

import { skipConductorNoticeRelay } from "./conductorNoticeRelay";
import { deliverEnvelope } from "./digestDelivery";
import { WAVE_FENCE_TAG } from "./flockWave";

/** What the request starts with, so its answer can be told apart. */
export const PLAN_RESEND_MARKER = "[flock-plan-resend]";

/** Every message the app itself sends a conductor starts so. */
const APP_MESSAGE_MARKER = "[flock-";

/** The request to the conductor, in the words of its own protocol. */
export function planResendRequest(reason: UnreadProtocolBlockReason): string {
  return `${PLAN_RESEND_MARKER} Your last reply carried a ${WAVE_FENCE_TAG} block ${unreadProtocolBlockPlace(reason)}, so the app did not run it. A plan runs only from a ${WAVE_FENCE_TAG} block that stands on its own lines at the top level of your reply, outside quotes, lists and other code blocks.

If you meant to run that plan, send it again now as exactly one top-level ${WAVE_FENCE_TAG} block. If you only quoted it, say so in one line and send no plan.`;
}

/**
 * Whether the conductor was asked already since the operator last spoke:
 * the reply answers a request, or one is waiting in its queue.
 */
function askedSinceOperatorSpoke(
  conductorSessionId: string,
  replyId: string,
): boolean {
  const chat = useChatStore.getState();
  const queued = chat.queuedMessageBySession[conductorSessionId] ?? [];
  if (queued.some((entry) => entry.payload.text.startsWith(PLAN_RESEND_MARKER)))
    return true;
  const messages: readonly Message[] =
    chat.messagesBySession[conductorSessionId] ?? [];
  const index = messages.findIndex((message) => message.id === replyId);
  for (let at = (index < 0 ? messages.length : index) - 1; at >= 0; at -= 1) {
    const message = messages[at];
    if (message.role !== "user") continue;
    const text = getTextContent(message).trimStart();
    if (text.startsWith(PLAN_RESEND_MARKER)) return true;
    // A digest, a relayed notice, a goal turn: the app's, not the operator's.
    if (!text.startsWith(APP_MESSAGE_MARKER)) return false;
  }
  return false;
}

/**
 * Says that the plan in `messageId` was not read, and asks the conductor
 * once to send it again — unless it was asked already, or its new work is on
 * hold and a new plan would only be refused.
 */
export function handleUnreadPlan(args: {
  conductorSessionId: string;
  messageId: string;
  createdAt: number;
  reason: UnreadProtocolBlockReason;
  held: boolean;
}): void {
  const followUp: UnreadPlanFollowUp = askedSinceOperatorSpoke(
    args.conductorSessionId,
    args.messageId,
  )
    ? "askedBefore"
    : args.held
      ? "onHold"
      : "asked";
  const noticeId = announceUnreadProtocolBlock({
    sessionId: args.conductorSessionId,
    messageId: args.messageId,
    created: args.createdAt,
    kind: "plan",
    reason: args.reason,
    followUp,
    type: "warning",
  });
  if (!noticeId) return;
  // On hold, the notice reaches the conductor the usual way. Otherwise it
  // already has the facts: in the request below, or in the one before.
  if (followUp === "onHold") return;
  skipConductorNoticeRelay(noticeId);
  if (followUp !== "asked") return;
  void deliverEnvelope(
    args.conductorSessionId,
    planResendRequest(args.reason),
  ).then((result) => {
    if (result.status !== "failed") return;
    useChatStore
      .getState()
      .addMessage(
        args.conductorSessionId,
        createSystemNotificationMessage(
          unreadPlanAskFailedText(result.detail ?? "unknown reason"),
          "error",
        ),
      );
  });
}
