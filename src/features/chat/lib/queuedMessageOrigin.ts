import type { QueuedMessageRecord } from "../stores/chatStore";
import type { MessageMetadata } from "@/shared/types/messages";

const DISTILLCTL_CROSS_SESSION_ORIGIN =
  "distillctl_cross_session" satisfies NonNullable<MessageMetadata["origin"]>;

/**
 * distillctl cross-session sends have their own dedicated drain
 * (`useDistillctlQueuedMessageDrain`); the chat queue drains must not claim them.
 */
export function isDistillctlCrossSessionQueuedMessage(
  record: QueuedMessageRecord | null | undefined,
): boolean {
  return (
    record?.kind === "transport-ready" &&
    record.payload.sendOptions?.userMessageMetadata?.origin ===
      DISTILLCTL_CROSS_SESSION_ORIGIN
  );
}
