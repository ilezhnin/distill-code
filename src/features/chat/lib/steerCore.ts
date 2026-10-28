import { isRecord } from "@/shared/lib/isRecord";
import { admitSystemInheritedQueuedMessage } from "./admittedSend";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { acpSteerMessage } from "@/shared/api/acp";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import {
  type ChatAttachmentDraft,
  createSystemNotificationMessage,
  createUserMessage,
} from "@/shared/types/messages";
import type { ChatSendOptions } from "../types";
import {
  formatAttachmentsTooLargeMessage,
  MAX_PROMPT_ATTACHMENT_BYTES,
  promptAttachmentBytes,
  PromptPayloadTooLargeError,
} from "./attachmentPayloadBudget";
import {
  appendAttachmentPaths,
  buildAcpImages,
  buildMessageAttachments,
} from "./attachments";
import { isSessionRunning } from "./sessionActivity";
import { getSessionPromptOwner } from "./sessionPromptOwnership";
import { i18n } from "@/shared/i18n";

function formatSteerErrorMessage(error: unknown): string {
  const message = formatAcpErrorMessage(error);
  return message.toLowerCase().includes("method not found")
    ? i18n.t("chat:errors.steeringBackendUnavailable")
    : message;
}

export async function steerPromptInSession(
  sessionId: string,
  text: string,
  attachments?: ChatAttachmentDraft[],
  sendOptions?: ChatSendOptions,
  options: {
    throwOnError?: boolean;
    queueIfUnavailable?: boolean;
    onDelivery?: (
      delivery: "queued" | "steer" | "steer_failed" | "steer_unconfirmed",
    ) => void;
  } = {},
): Promise<boolean> {
  const images = buildAcpImages(attachments);
  const hasAttachments = (attachments?.length ?? 0) > 0;
  const activeRunId = useChatStore
    .getState()
    .getSessionRuntime(sessionId).activeRunId;
  const promptOwner = getSessionPromptOwner(sessionId);

  if (!text.trim() && !hasAttachments) {
    return false;
  }

  // Defense-in-depth mirror of the dispatchPrompt guard: the composer
  // already budget-checks steers synchronously, but non-composer callers
  // (flockctl, queued steers) reach here directly. An oversized ACP message
  // silently kills the shared WebSocket and every open chat (BOT-1463), so
  // reject before committing anything.
  const attachmentBytes = promptAttachmentBytes(attachments);
  if (attachmentBytes > MAX_PROMPT_ATTACHMENT_BYTES) {
    const errorMessage = formatAttachmentsTooLargeMessage(attachmentBytes);
    useChatStore
      .getState()
      .addMessage(
        sessionId,
        createSystemNotificationMessage(errorMessage, "error"),
      );
    if (options.throwOnError) {
      throw new PromptPayloadTooLargeError(errorMessage);
    }
    return false;
  }

  const userMessage = createUserMessage(
    sendOptions?.displayText ?? text,
    buildMessageAttachments(attachments),
    sendOptions?.chips,
  );
  userMessage.metadata = {
    ...userMessage.metadata,
    ...sendOptions?.userMessageMetadata,
    delivery: "steering",
    steeringRequestId: userMessage.id,
  };

  if (images && images.length > 0) {
    for (const img of images) {
      userMessage.content.push({
        type: "image",
        data: img.base64,
        mimeType: img.mimeType,
      });
    }
  }

  const promptWithPaths = appendAttachmentPaths(text.trim(), attachments);
  const acpPrompt = promptWithPaths || (images?.length ? " " : promptWithPaths);
  const chatStore = useChatStore.getState();
  chatStore.addMessage(sessionId, userMessage);
  chatStore.setPendingInterventionBoundary(sessionId, {
    interventionMessageId: userMessage.id,
  });

  try {
    const steerResponse = await acpSteerMessage(
      sessionId,
      activeRunId,
      acpPrompt,
      {
        ...(sendOptions?.assistantPrompt
          ? { assistantPrompt: sendOptions.assistantPrompt }
          : {}),
        promptMeta: sendOptions?.acpPromptMetadata,
        images: images?.map(
          (img) => [img.base64, img.mimeType] as [string, string],
        ),
      },
    );
    if (steerResponse.delivery === "queued") {
      const store = useChatStore.getState();
      store.removeMessage(sessionId, userMessage.id);
      store.setPendingInterventionBoundary(sessionId, null);
      if (!options.queueIfUnavailable) return false;
      const accepted = store.enqueueTransportReadyMessage(
        sessionId,
        admitSystemInheritedQueuedMessage({
          text,
          attachments,
          sendOptions,
          executorRequestKey: sendOptions?.executorRequestKey,
        }),
      );
      if (accepted) {
        options.onDelivery?.("queued");
      } else if (options.throwOnError) {
        throw Object.assign(
          new Error("The message queue could not accept this input."),
          { code: -32602 },
        );
      }
      return accepted;
    }
    options.onDelivery?.(steerResponse.delivery ?? "steer");
    const acknowledgedDelivery = steerResponse.delivery ?? "steering";
    const steeredRunId = steerResponse.runId;
    const liveStore = useChatStore.getState();
    liveStore.replaceMessageId(
      sessionId,
      userMessage.id,
      steerResponse.messageId,
    );
    const acknowledgedMessage =
      liveStore.messagesBySession[sessionId]?.find(
        (message) => message.id === steerResponse.messageId,
      ) ?? userMessage;
    const deliveryArrivedBeforeAcknowledgement =
      acknowledgedMessage.metadata?.delivery === "steer";
    if (!deliveryArrivedBeforeAcknowledgement) {
      liveStore.updateMessage(
        sessionId,
        steerResponse.messageId,
        (message) => ({
          ...message,
          metadata: {
            ...message.metadata,
            delivery: acknowledgedDelivery,
          },
        }),
      );
    }
    if (
      (deliveryArrivedBeforeAcknowledgement ||
        steerResponse.delivery !== undefined) &&
      liveStore.getSessionRuntime(sessionId).pendingInterventionBoundary
        ?.interventionMessageId === steerResponse.messageId
    ) {
      liveStore.setPendingInterventionBoundary(sessionId, null);
    }
    const liveRuntime = liveStore.getSessionRuntime(sessionId);
    const promptStillOwnsSession =
      promptOwner !== null && getSessionPromptOwner(sessionId) === promptOwner;
    const runIsStillActive =
      (liveRuntime.activeRunId === steeredRunId ||
        liveRuntime.activeRunId === activeRunId) &&
      (activeRunId !== null || promptStillOwnsSession) &&
      !liveRuntime.isRunCancellationPending &&
      isSessionRunning(liveRuntime.chatState);
    // A stop or natural completion can finish the run while steer is awaiting
    // its acknowledgement. Do not restore that stale run after it has ended.
    if (runIsStillActive) {
      liveStore.setActiveRunId(sessionId, steeredRunId);
    }
    useChatSessionStore.getState().patchSession(sessionId, {
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const liveStore = useChatStore.getState();
    const liveMessage = liveStore.messagesBySession[sessionId]?.find(
      (message) =>
        message.id === userMessage.id ||
        message.metadata?.steeringRequestId === userMessage.id,
    );
    const deliveryWasEstablished = liveMessage?.metadata?.delivery === "steer";
    const rejectedBeforeDispatch =
      isRecord(err) &&
      (err.code === -32602 ||
        err.code === -32601 ||
        (isRecord(err.data) &&
          err.data.promptNotAccepted === true &&
          err.data.dispatchStarted === false));
    if (!deliveryWasEstablished && !rejectedBeforeDispatch) {
      // A timeout or broken socket says nothing about provider acceptance.
      // Keep the input visible and stop automatic retries of this delivery id.
      liveStore.updateMessage(
        sessionId,
        liveMessage?.id ?? userMessage.id,
        (message) => ({
          ...message,
          metadata: { ...message.metadata, delivery: "steer_unconfirmed" },
        }),
      );
      liveStore.setPendingInterventionBoundary(sessionId, null);
      // The socket may have failed before the host saved anything. Retain a
      // separate durable review item; deferred records never auto-dispatch.
      liveStore.enqueueDeferredMessage(
        sessionId,
        admitSystemInheritedQueuedMessage({
          text,
          attachments,
          sendOptions: {
            ...sendOptions,
            userMessageMetadata: {
              ...sendOptions?.userMessageMetadata,
              delivery: "steer_unconfirmed",
            },
          },
          executorRequestKey: sendOptions?.executorRequestKey,
        }),
        { type: "steering-review", status: "held" },
      );
      options.onDelivery?.("steer_unconfirmed");
    } else if (!deliveryWasEstablished) {
      const liveMessageId = liveMessage?.id ?? userMessage.id;
      liveStore.removeMessage(sessionId, liveMessageId);
      if (
        liveStore.getSessionRuntime(sessionId).pendingInterventionBoundary
          ?.interventionMessageId === liveMessageId
      ) {
        liveStore.setPendingInterventionBoundary(sessionId, null);
      }
      const errorMessage = formatSteerErrorMessage(err);
      liveStore.addMessage(
        sessionId,
        createSystemNotificationMessage(errorMessage, "error"),
      );
      if (options.throwOnError) {
        throw new Error(errorMessage);
      }
      return false;
    }
  }
  // The input was accepted or retained for inspection after an uncertain
  // transport result. A queued fallback fires its commit callback later,
  // through normal dispatch, and an explicitly rejected input never fires it.
  sendOptions?.onUserMessageCommitted?.();
  return true;
}
