/**
 * A wave step goes on after its account's limit cut its turn off.
 *
 * An ordinary chat whose turn was cut off goes on under a spare account
 * when the host found one (`spareAccountContinuation.ts`); a wave step was
 * left to its engine, and the engine did nothing. The turn had ended, so
 * the step read as finished without a report, and the wave built on that
 * or stood still (11-14).
 *
 * The step now gets the same continuation in its own queue. With a spare
 * account ready, dispatching it moves the chat there. With none, the
 * provider refuses it before the turn begins, the chat waits for the reset
 * like any refused message, and the step shows as waiting — which the wave
 * tells its conductor, with the time. A step with a message in its queue
 * has not ended (`useConductorGraphSync`), so nothing is read into the
 * cut-off turn meanwhile.
 */

import { admitSystemInheritedQueuedMessage } from "@/features/chat/lib/admittedSend";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";

import { spareAccountToContinueOn } from "./spareAccountContinuation";

/** What a wave step is told when its turn goes on after the cut-off. */
export const LIMIT_CONTINUATION_TEXT =
  "Your previous turn was cut off because its account ran out of its usage limit. " +
  "Continue the work from where you stopped, and end with your report.";

/**
 * Whether a turn that had begun ended on its account's limit: the host
 * says so in a field (`data.cutOffByLimit`), and names a spare account
 * when one is ready.
 */
export function turnCutOffByLimit(error: unknown): boolean {
  if (spareAccountToContinueOn(error)) return true;
  if (!error || typeof error !== "object" || !("data" in error)) return false;
  const data = error.data;
  return (
    typeof data === "object" &&
    data !== null &&
    "cutOffByLimit" in data &&
    data.cutOffByLimit === true
  );
}

/** Whether `sessionId` runs a wave's step. */
export function isWaveStepSession(sessionId: string): boolean {
  return (
    useConductorGraphStore.getState().getNode(sessionId)?.managedBy === "wave"
  );
}

/**
 * Queues the continuation for a wave step whose turn its account's limit
 * cut off. A queue that already holds a message is left as it is: that
 * message goes to the provider next and continues the chat just the same.
 * Returns whether something is now on its way.
 */
export function queueLimitContinuation(
  sessionId: string,
  error: unknown,
): boolean {
  if (!turnCutOffByLimit(error)) return false;
  const chat = useChatStore.getState();
  return (
    (chat.queuedMessageBySession[sessionId]?.length ?? 0) > 0 ||
    chat.enqueueTransportReadyMessage(
      sessionId,
      admitSystemInheritedQueuedMessage({ text: LIMIT_CONTINUATION_TEXT }),
    )
  );
}
