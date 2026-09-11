import type { MessageMetadata } from "@/shared/types/messages";
import { isRecord } from "@/shared/lib/isRecord";

type ReplayMetadataSource = {
  _meta?: Record<string, unknown> | null;
  messageId?: string | null;
};

export type ReplayAssistantMetadata = Pick<
  MessageMetadata,
  "personaId" | "personaName"
>;
export type ReplayUserMetadata = Pick<
  MessageMetadata,
  "delivery" | "origin" | "berdSenderLabel" | "berdDeliveryId"
>;

export function getReplayMessageId(
  source: ReplayMetadataSource,
): string | null {
  if (source.messageId) {
    return source.messageId;
  }

  const metaMessageId = getHostReplayMeta(source)?.messageId;
  if (typeof metaMessageId === "string" && metaMessageId.length > 0) {
    return metaMessageId;
  }

  return null;
}

export function getReplayCreated(
  source: ReplayMetadataSource,
): number | undefined {
  const meta = getHostReplayMeta(source);
  return coerceReplayTimestamp(meta?.created ?? meta?.createdAt);
}

export function getReplayAssistantMetadata(
  source: ReplayMetadataSource,
): ReplayAssistantMetadata | undefined {
  const meta = getHostReplayMeta(source);
  if (!meta) {
    return undefined;
  }

  const personaId = nonEmptyString(meta.personaId);
  const personaName = nonEmptyString(meta.personaName);
  if (!personaId && !personaName) {
    return undefined;
  }

  return {
    ...(personaId ? { personaId } : {}),
    ...(personaName ? { personaName } : {}),
  };
}

export function getReplayUserMetadata(
  source: ReplayMetadataSource,
): ReplayUserMetadata | undefined {
  const meta = getHostReplayMeta(source);
  if (!meta) {
    return undefined;
  }

  const delivery = meta.steer === true ? "steer" : undefined;
  const origin =
    meta.origin === "berdctl_cross_session"
      ? "berdctl_cross_session"
      : undefined;
  const berdSenderLabel = origin
    ? boundedSingleLineString(meta.berdSenderLabel, 120)
    : undefined;
  const berdDeliveryId = origin
    ? boundedSingleLineString(meta.berdDeliveryId, 200)
    : undefined;
  if (!delivery && !origin) {
    return undefined;
  }

  return {
    ...(delivery ? { delivery } : {}),
    ...(origin ? { origin } : {}),
    ...(berdSenderLabel ? { berdSenderLabel } : {}),
    ...(berdDeliveryId ? { berdDeliveryId } : {}),
  };
}

function boundedSingleLineString(
  value: unknown,
  maxLength: number,
): string | undefined {
  const normalized = nonEmptyString(value);
  return normalized &&
    normalized.length <= maxLength &&
    !normalized.includes("\n") &&
    !normalized.includes("\r")
    ? normalized
    : undefined;
}

/** Replay bookkeeping the host stamps on every persisted update. */
function getHostReplayMeta(
  source: ReplayMetadataSource,
): Record<string, unknown> | null {
  if (!isRecord(source._meta)) {
    return null;
  }

  const meta = source._meta.distill;
  return isRecord(meta) ? meta : null;
}

function coerceReplayTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") {
    return normalizeEpochMilliseconds(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function normalizeEpochMilliseconds(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
