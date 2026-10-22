import type { QueuedMessageRecord } from "../stores/chatStore";
import type { MessageMetadata } from "@/shared/types/messages";

const FLOCKCTL_CROSS_SESSION_ORIGIN =
  "distillctl_cross_session" satisfies NonNullable<MessageMetadata["origin"]>;

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
