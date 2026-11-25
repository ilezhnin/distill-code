import { sendPromptInBackground } from "@/features/chat/lib/backgroundSend";
import {
  acquireExistingSessionForBackgroundSend,
  prepareExistingSessionForBackgroundSend,
  SessionDispatchContentionError,
  SessionDispatchCreationIncompleteError,
  SessionDispatchMissingError,
  SessionDispatchUnresolvedError,
} from "@/features/chat/lib/queuedSessionSend";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
export {
  sendQueuedPromptToExistingSessionInBackground,
  SessionDispatchContentionError,
  SessionDispatchCreationIncompleteError,
  SessionDispatchMissingError,
  SessionDispatchUnresolvedError,
} from "@/features/chat/lib/queuedSessionSend";
import { formatIncludedWorkspacesPrompt } from "@/features/chat/lib/workspaceAttachments";
import {
  flockctlCommandSendOptions,
  flockctlCrossSessionSendOptions,
} from "@/features/chat/lib/queuedMessageOrigin";
import type { ChatSendOptions } from "@/features/chat/types";
import { accountQuotaWaitData } from "@/features/chat/lib/accountQuotaWait";
import type { CommandContext } from "../types";
export { isFlockctlCrossSessionQueuedMessage } from "@/features/chat/lib/queuedMessageOrigin";

export {
  FLOCKCTL_CROSS_SESSION_ORIGIN,
  flockctlCrossSessionSendOptions,
} from "@/features/chat/lib/queuedMessageOrigin";

/**
 * Send options for the message a `session send` or `session create` call
 * delivers.
 *
 * A call that came in over the broker is some process's, and its message
 * always names a sender: the caller's `--from`, or the command's own name
 * for it. The app dispatching the same command itself (the memory review
 * chat) is the app speaking, and its message names none, like every other
 * message the app sends into a chat.
 *
 * A broker call without the agent mark or an actor is the operator's own
 * terminal, the one caller besides the composer whose /goal and /loop run
 * as commands; an agent's reach its chat as text.
 */
export function sendOptionsForCall(
  ctx: Pick<CommandContext, "viaBroker" | "fromAgent" | "actor">,
  options: { senderLabel?: string; deliveryId?: string },
): ChatSendOptions {
  return ctx.viaBroker
    ? flockctlCommandSendOptions({
        ...options,
        caller: ctx.fromAgent || ctx.actor ? "agent" : "operator",
      })
    : flockctlCrossSessionSendOptions(options);
}

const reservedDeliveryIds = new Set<string>();

export class FlockctlDeliveryAlreadyAcceptedError extends Error {
  constructor() {
    super("The Flock delivery was already accepted.");
    this.name = "FlockctlDeliveryAlreadyAcceptedError";
  }
}

export function hasAcceptedFlockctlDelivery(
  sessionId: string,
  deliveryId: string,
): boolean {
  const chatStore = useChatStore.getState();
  return (
    hasAcceptedFlockctlDeliveryInTranscript(sessionId, deliveryId) ||
    (chatStore.queuedMessageBySession[sessionId] ?? []).some(
      (record) =>
        record.payload.sendOptions?.userMessageMetadata?.distillDeliveryId ===
        deliveryId,
    )
  );
}

export function hasAcceptedFlockctlDeliveryInTranscript(
  sessionId: string,
  deliveryId: string,
): boolean {
  return (useChatStore.getState().messagesBySession[sessionId] ?? []).some(
    (message) =>
      message.metadata?.distillDeliveryId === deliveryId &&
      message.metadata?.delivery !== "steering",
  );
}

export function reserveFlockctlDelivery(
  sessionId: string,
  deliveryId: string,
): (() => void) | null {
  const key = JSON.stringify([sessionId, deliveryId]);
  if (reservedDeliveryIds.has(key)) {
    // In flight is not accepted: acknowledging this retry could make a
    // monitor drop its spool entry before the original attempt is rejected.
    throw new Error(
      "This delivery is still pending. Retry with the same delivery id after it settles.",
    );
  }
  if (hasAcceptedFlockctlDelivery(sessionId, deliveryId)) return null;
  reservedDeliveryIds.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reservedDeliveryIds.delete(key);
  };
}

export async function sendPromptToExistingSessionInBackground(
  sessionId: string,
  prompt: string,
  beforeUserMessageCommitted?: () => void,
  options: {
    returnOnDispatch?: boolean;
    sendOptions?: ChatSendOptions;
    validateHydratedTranscript?: () => void;
    /** Explicit host rollback proof after an optimistic dispatch acknowledgement. */
    onPromptNotAccepted?: () => void;
  } = {},
): Promise<void> {
  const acquisition = await acquireExistingSessionForBackgroundSend(sessionId);
  if (acquisition.status === "contended") {
    throw new SessionDispatchContentionError(acquisition.waiter);
  }
  if (acquisition.status === "unresolved") {
    throw new SessionDispatchUnresolvedError();
  }
  if (acquisition.status === "session-missing") {
    throw new SessionDispatchMissingError(sessionId);
  }
  if (acquisition.status === "creation-incomplete") {
    throw new SessionDispatchCreationIncompleteError(acquisition.creationState);
  }
  const targetLease = acquisition;
  let dispatched = false;
  let resolveDispatch: (() => void) | undefined;
  let rejectDispatch: ((error: unknown) => void) | undefined;
  const dispatch = options.returnOnDispatch
    ? new Promise<void>((resolve, reject) => {
        resolveDispatch = resolve;
        rejectDispatch = reject;
      })
    : null;
  const settlement = (async () => {
    try {
      const { providerId, persona } =
        await prepareExistingSessionForBackgroundSend(sessionId, {
          executionTarget: targetLease.target,
          dispatchToken: targetLease.token,
        });
      const session = useChatSessionStore.getState().getSession(sessionId);
      options.validateHydratedTranscript?.();
      await sendPromptInBackground(
        sessionId,
        prompt,
        providerId,
        persona,
        {
          ...(options.sendOptions ?? flockctlCrossSessionSendOptions()),
          systemPrompt: session
            ? formatIncludedWorkspacesPrompt(session)
            : undefined,
        },
        undefined,
        beforeUserMessageCommitted,
        undefined,
        undefined,
        () => {
          dispatched = true;
          resolveDispatch?.();
        },
      );
    } catch (error) {
      if (
        dispatched &&
        accountQuotaWaitData(error)?.promptNotAccepted === true
      ) {
        options.onPromptNotAccepted?.();
      }
      if (!dispatched) rejectDispatch?.(error);
      throw error;
    } finally {
      targetLease.release();
    }
  })();
  if (!dispatch) return settlement;
  void settlement.catch(() => {
    // Pre-dispatch failures are returned through `dispatch`; post-dispatch
    // failures are already recorded and logged by the background send path.
  });
  return dispatch;
}
