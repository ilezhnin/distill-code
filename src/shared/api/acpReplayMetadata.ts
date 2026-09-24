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
  "delivery" | "origin" | "distillSenderLabel" | "distillDeliveryId"
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

/**
 * The id of the assistant message an agent-side update (message and thought
 * chunks, tool calls) belongs to. The host names the reply apart from the
 * prompt in `_meta.distill.assistantMessageId`; history recorded before that
 * only carries the prompt's `messageId`, so its reply is folded under a
 * derived `${messageId}:reply` instead of colliding with the user message.
 */
export function getReplayAssistantMessageId(
  source: ReplayMetadataSource,
): string | null {
  if (source.messageId) {
    return source.messageId;
  }

  const assistantMessageId = getHostAssistantMessageId(source);
  if (assistantMessageId) {
    return assistantMessageId;
  }

  const promptMessageId = getHostReplayMeta(source)?.messageId;
  if (typeof promptMessageId === "string" && promptMessageId.length > 0) {
    return legacyReplayReplyId(promptMessageId);
  }

  return null;
}

/** Marks an id the renderer derived for a reply the host never named. */
const LEGACY_REPLY_ID_SUFFIX = ":reply";

/**
 * The id a replayed reply gets when its history names no reply of its own:
 * history recorded before the host stamped `assistantMessageId`, or an
 * update with no ids at all.
 */
export function legacyReplayReplyId(anchor: string): string {
  return `${anchor}${LEGACY_REPLY_ID_SUFFIX}`;
}

/**
 * True for a reply whose id was derived on replay rather than given by the
 * host.
 *
 * Such a reply was streamed, and every fence in it handled, under an id the
 * renderer made up at the time, which no reload can reproduce. Every scanner
 * that acts on a settled reply exactly once (wave plans, memory and recall
 * fences) must treat it as already handled: its tombstone
 * is filed under the old id, so a reply that now reads as new would plan the
 * wave again or keep the memory again. Before replies
 * were folded under this id they replayed as one unfinished bubble per chunk
 * and no scanner ever read them, so skipping them keeps exactly that.
 */
export function isLegacyReplayReplyId(messageId: string): boolean {
  return messageId.endsWith(LEGACY_REPLY_ID_SUFFIX);
}

/** The reply id the host stamps on every agent-side update of a turn. */
export function getHostAssistantMessageId(
  source: ReplayMetadataSource,
): string | null {
  const assistantMessageId = getHostReplayMeta(source)?.assistantMessageId;
  return typeof assistantMessageId === "string" && assistantMessageId.length > 0
    ? assistantMessageId
    : null;
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
    meta.origin === "distillctl_cross_session"
      ? "distillctl_cross_session"
      : undefined;
  const distillSenderLabel = origin
    ? boundedSingleLineString(meta.distillSenderLabel, 120)
    : undefined;
  const distillDeliveryId = origin
    ? boundedSingleLineString(meta.distillDeliveryId, 200)
    : undefined;
  if (!delivery && !origin) {
    return undefined;
  }

  return {
    ...(delivery ? { delivery } : {}),
    ...(origin ? { origin } : {}),
    ...(distillSenderLabel ? { distillSenderLabel } : {}),
    ...(distillDeliveryId ? { distillDeliveryId } : {}),
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
