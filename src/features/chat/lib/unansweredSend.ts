/**
 * The turn that was killed in flight.
 *
 * A message sent to an agent and then interrupted — the app closed, the
 * process gone — leaves the transcript ending on the operator's own words.
 * Nothing replays it: a message still in the queue at restart is delivered,
 * but one that was already sent and killed is simply lost, and until now it
 * was lost *silently*. The operator reads a chat that looks like the agent
 * ignored them.
 *
 * The fix is to say so, not to re-send. Re-sending on its own would re-run
 * work the agent may well have finished before it died — a commit, a
 * deletion, a message to someone else — and the app cannot know which. So
 * the transcript gets a notice and a button, and the operator decides.
 *
 * The detection is pure; `resendUnansweredMessage` is the effect.
 */

import { sendPromptToExistingSessionInBackground } from "@/features/berdctl/commands/runtime/sessionSend";
import { getTextContent, type Message } from "@/shared/types/messages";

/**
 * The trailing user message that never got an answer, or null.
 *
 * System messages are skipped on the way back: notices about the load
 * itself sit at the end of the transcript and are not answers to anything.
 * Anything else — an assistant turn, even an empty or truncated one — means
 * the agent did reply, and this is not the case being described.
 */
export function findUnansweredUserMessage(
  messages: readonly Message[] | undefined,
): Message | null {
  if (!messages?.length) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "system") continue;
    if (message.role !== "user") return null;
    // A message with nothing to re-send is not worth a button.
    return getTextContent(message).trim() ? message : null;
  }
  return null;
}

/** Stable id, so a reload replaces the notice instead of stacking copies. */
export function interruptedTurnNoticeId(sessionId: string): string {
  return `session-interrupted-turn:${sessionId}`;
}

export interface UnansweredSendContext {
  /** True while the session has a run of its own — the answer is coming. */
  isRunning: boolean;
  /**
   * True when the session already carries a failure.
   *
   * The error notice has said what went wrong; adding "this was never
   * answered" underneath it reports the same event twice, in vaguer words.
   */
  hasError: boolean;
  /** True when a queued send will start the session on its own. */
  hasQueuedSend: boolean;
  /**
   * True for a session the wave engine owns.
   *
   * A worker whose step was killed is already reported by the conductor's own
   * reconcile, as a stopped node with no report — a second notice in its tab
   * would say the same thing twice, and its button would re-run the step
   * outside the wave that scheduled it.
   */
  isAgentManaged: boolean;
}

/**
 * Whether a loaded transcript should carry the interrupted-turn notice.
 *
 * Every guard matters and none is redundant: a session that is running right
 * now legitimately ends on the operator's message, so does one whose queued
 * first send has not been drained yet, a failed one has already said why in
 * its own words, and a wave worker is the conductor's to report. Claiming a
 * dropped message in any of the four would be a false alarm on the states
 * that occur most.
 */
export function unansweredSendToReport(
  messages: readonly Message[] | undefined,
  context: UnansweredSendContext,
): Message | null {
  if (context.isRunning || context.hasQueuedSend || context.hasError) {
    return null;
  }
  if (context.isAgentManaged) return null;
  return findUnansweredUserMessage(messages);
}

/** Sends the interrupted message again, as a real user turn. */
export function resendUnansweredMessage(sessionId: string, text: string): void {
  const prompt = text.trim();
  if (!prompt) return;
  void sendPromptToExistingSessionInBackground(sessionId, prompt).catch(
    (error: unknown) => {
      console.error("Failed to send the interrupted message again:", error);
    },
  );
}
