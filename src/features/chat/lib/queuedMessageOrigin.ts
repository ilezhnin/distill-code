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
 * The sender label of a message a flockctl command delivered for a caller
 * that named none.
 *
 * The app's own cross-session messages (a wave digest, the notice about a
 * silent job) go through the same seam as `flockctl session send` and carry
 * the same origin, so the origin cannot tell them apart. What can is the
 * label: every message delivered for a call that came in over the broker
 * carries one, the caller's `--from` or this, and the app's own carry none.
 * A caller of the CLI cannot make a message without it, which is what the
 * transcript relies on when it draws a digest card only for a message that
 * has no label.
 */
export const FLOCKCTL_COMMAND_SENDER = "flockctl";

/**
 * Send options for a message a flockctl command delivers for its caller.
 *
 * `caller` is who made the call as the broker saw it: `"operator"` for a call
 * without the agent mark (the operator's own terminal), `"agent"` for one
 * from an agent's shell. Only the operator's /goal and /loop run as commands;
 * an agent's, or a call whose caller is not said, reach the agent as text.
 */
export function flockctlCommandSendOptions(
  options: {
    senderLabel?: string;
    deliveryId?: string;
    caller?: "operator" | "agent";
  } = {},
): ChatSendOptions {
  const { caller, ...delivery } = options;
  return {
    ...flockctlCrossSessionSendOptions({
      ...delivery,
      senderLabel: delivery.senderLabel ?? FLOCKCTL_COMMAND_SENDER,
    }),
    ...(caller === "operator"
      ? { commandOrigin: "operator-terminal" as const }
      : {}),
  };
}

/**
 * Whether a message says who sent it, with a sender label or a delivery id.
 * Every message a caller of flockctl had delivered does; the app's own
 * unnamed cross-session messages do not (see {@link FLOCKCTL_COMMAND_SENDER}).
 */
export function hasNamedSender(
  metadata:
    | Pick<MessageMetadata, "distillSenderLabel" | "distillDeliveryId">
    | undefined,
): boolean {
  return Boolean(metadata?.distillSenderLabel || metadata?.distillDeliveryId);
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
