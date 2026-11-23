import type { QueuedMessageRecord } from "../stores/chatStore";
import type { MessageMetadata } from "@/shared/types/messages";

import type { ChatSendOptions } from "../types";

export const FLOCKCTL_CROSS_SESSION_ORIGIN =
  "distillctl_cross_session" satisfies NonNullable<MessageMetadata["origin"]>;

export function flockctlCrossSessionSendOptions(
  options: { senderLabel?: string; deliveryId?: string } = {},
): ChatSendOptions {
  const senderMetadata = options.senderLabel
    ? { distillSenderLabel: options.senderLabel }
    : {};
  const deliveryMetadata = options.deliveryId
    ? { distillDeliveryId: options.deliveryId }
    : {};
  return {
    userMessageMetadata: {
      origin: FLOCKCTL_CROSS_SESSION_ORIGIN,
      ...senderMetadata,
      ...deliveryMetadata,
    },
    acpPromptMetadata: {
      origin: FLOCKCTL_CROSS_SESSION_ORIGIN,
      ...senderMetadata,
      ...deliveryMetadata,
    },
  };
}

/**
 * flockctl cross-session sends have their own dedicated drain
 * (`useFlockctlQueuedMessageDrain`); the chat queue drains must not claim them.
 */
export function isFlockctlCrossSessionQueuedMessage(
  record: QueuedMessageRecord | null | undefined,
): boolean {
  return (
    record?.kind === "transport-ready" &&
    record.payload.sendOptions?.userMessageMetadata?.origin ===
      FLOCKCTL_CROSS_SESSION_ORIGIN
  );
}
