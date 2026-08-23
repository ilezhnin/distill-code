/**
 * The envelope: how a finished child's result reaches its parent session.
 *
 * Contract 3 of the combined plan, and the architectural point of this whole
 * item: a report going up is a **real user message** in the parent's
 * transcript, delivered through the same berdctl cross-session seam an external
 * `berdctl session send` uses. That is what makes the parent's model actually
 * run again. The synthetic assistant message the sync used to append
 * (`publishCompletedTurns`) never did — the parent read it and stayed asleep.
 *
 * The message carries `origin: "berdctl_cross_session"`, from
 * `berdctlCrossSessionSendOptions()`. That origin cannot seed a wave: the plan
 * detector only ever scans *assistant* messages, so a digest is structurally
 * invisible to it whatever its text contains.
 *
 * A busy parent is queued, never dropped. Every error the seam can throw has a
 * defined outcome here, and the caller always learns which one it got:
 *
 * | thrown                                     | outcome            |
 * |--------------------------------------------|--------------------|
 * | `SessionDispatchContentionError`             | `queued`           |
 * | `SessionDispatchCreationIncompleteError` (pending) | `queued`   |
 * | `SessionDispatchCreationIncompleteError` (failed)  | `failed`   |
 * | other `PreCommitSendRejectedError`           | `queued`           |
 * | `SessionDispatchMissingError`                | `failed`           |
 * | `SessionDispatchUnresolvedError`             | `failed`           |
 * | anything else                                | `failed`           |
 *
 * `queued` is durable: the queue is persisted and drained by the background
 * drain, so it is a delivery that has not happened yet, not a lost one.
 */

import {
  admitSystemInheritedQueuedMessage,
  type AdmittedQueuedMessagePayload,
} from "@/features/chat/lib/admittedSend";
import { PreCommitSendRejectedError } from "@/features/chat/lib/preCommitSendRejection";
import { isQueuedSessionReady } from "@/features/chat/lib/queuedMessageReadiness";
import {
  SessionDispatchContentionError,
  SessionDispatchCreationIncompleteError,
  SessionDispatchMissingError,
  SessionDispatchUnresolvedError,
} from "@/features/chat/lib/sessionDispatchAcquisition";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  berdctlCrossSessionSendOptions,
  sendPromptToExistingSessionInBackground,
} from "@/features/berdctl/commands/runtime/sessionSend";

/** What became of one envelope delivery. */
export type DigestDeliveryStatus =
  /** Committed into the parent transcript and dispatched to its model. */
  | "dispatched"
  /** Parked in the parent's persisted queue; it drains when the parent frees. */
  | "queued"
  /** Not delivered and not recoverable on its own. The caller must show it. */
  | "failed";

export interface DigestDeliveryResult {
  status: DigestDeliveryStatus;
  /** Operator-readable reason. Present only on `failed`. */
  detail?: string;
}

/**
 * Classifies a dispatch failure into "park it in the queue" or "tell the
 * operator". Pure, so the table above is testable without a runtime.
 */
export function classifyDigestDispatchError(
  error: unknown,
): DigestDeliveryResult {
  if (error instanceof SessionDispatchContentionError) {
    return { status: "queued" };
  }
  if (error instanceof SessionDispatchCreationIncompleteError) {
    return error.creationState === "failed"
      ? { status: "failed", detail: error.message }
      : { status: "queued" };
  }
  if (error instanceof SessionDispatchMissingError) {
    return { status: "failed", detail: error.message };
  }
  if (error instanceof SessionDispatchUnresolvedError) {
    return { status: "failed", detail: error.message };
  }
  if (error instanceof PreCommitSendRejectedError) {
    return { status: "queued" };
  }
  return {
    status: "failed",
    detail: error instanceof Error ? error.message : String(error),
  };
}

function digestQueuePayload(text: string): AdmittedQueuedMessagePayload {
  return admitSystemInheritedQueuedMessage({
    text,
    sendOptions: berdctlCrossSessionSendOptions(),
  });
}

/**
 * Delivers one prompt to `sessionId` as a real user message.
 *
 * Used for every message this feature sends into a session it is not: the wave
 * digest, the non-wave group digest, and the operator's poke. They differ only
 * in their text; the delivery guarantees are identical and belong in one place.
 *
 * Never throws: the whole point of the outcome type is that the caller has to
 * decide what a failure means for its own state machine, and a rejected promise
 * inside a store subscription would just be an unhandled rejection.
 */
export async function deliverEnvelope(
  sessionId: string,
  text: string,
): Promise<DigestDeliveryResult> {
  const chat = useChatStore.getState();
  const runtime = chat.getSessionRuntime(sessionId);
  const queueLength = chat.queuedMessageBySession[sessionId]?.length ?? 0;
  // Busy or already holding a queue: go straight to the queue rather than
  // racing the lease and handling the contention error we would provoke.
  if (queueLength > 0 || !isQueuedSessionReady(runtime)) {
    chat.enqueueTransportReadyMessage(sessionId, digestQueuePayload(text));
    return { status: "queued" };
  }

  try {
    await sendPromptToExistingSessionInBackground(sessionId, text, undefined, {
      returnOnDispatch: true,
    });
    return { status: "dispatched" };
  } catch (error) {
    const result = classifyDigestDispatchError(error);
    if (result.status === "queued") {
      useChatStore
        .getState()
        .enqueueTransportReadyMessage(sessionId, digestQueuePayload(text));
    }
    return result;
  }
}
