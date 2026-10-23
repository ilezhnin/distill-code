import { RequestError, type AnyMessage } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { isRecord } from "@/shared/lib/isRecord";

export const HOST_MESSAGE_USAGE_METHOD = "_flock/session/message_usage";

const measurement = z.number().finite().nonnegative();
const metadata = z.record(z.string(), z.unknown()).nullish();
const messageUsageNotification = z.object({
  sessionId: z.string().min(1),
  update: z.object({
    sessionUpdate: z.literal("message_usage"),
    usage: z
      .object({
        inputTokens: measurement.optional(),
        outputTokens: measurement.optional(),
        cacheReadTokens: measurement.optional(),
        cacheWriteTokens: measurement.optional(),
        elapsedMs: measurement.optional(),
        cost: measurement.nullish(),
      })
      .refine((usage) => Object.keys(usage).length > 0),
    _meta: metadata,
  }),
  _meta: metadata,
});

export type HostMessageUsageNotification = z.infer<
  typeof messageUsageNotification
>;

/**
 * The host persists per-turn usage alongside ACP updates. SDK 1.5 accepts
 * cumulative/context usage_update, but not this delta variant. Route only
 * that known variant through a typed host extension before SDK dispatch;
 * standard updates and unknown variants retain the SDK's validation.
 * This also handles old replay rows without changing their stored evidence.
 */
export function adaptHostMessageUsage(message: AnyMessage): AnyMessage {
  if (
    "id" in message ||
    !("method" in message) ||
    message.method !== "session/update" ||
    !isRecord(message.params) ||
    !isRecord(message.params.update) ||
    message.params.update.sessionUpdate !== "message_usage"
  ) {
    return message;
  }
  return { ...message, method: HOST_MESSAGE_USAGE_METHOD };
}

export function parseHostMessageUsage(
  params: Record<string, unknown>,
): HostMessageUsageNotification {
  const parsed = messageUsageNotification.safeParse(params);
  if (!parsed.success) {
    throw RequestError.invalidParams(undefined, "Invalid host message usage");
  }
  return parsed.data;
}
