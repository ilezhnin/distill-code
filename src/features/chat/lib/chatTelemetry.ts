/**
 * Thin, feature-scoped wrappers over the vendored `berd_chat` event factories,
 * mirroring `src/features/agents/lib/agentTelemetry.ts`.
 *
 * Each wrapper builds the vendored schema event and hands it to the shared
 * telemetry `track` chokepoint, inheriting its prod/staging gate, consent
 * gating, and startup buffering/backdating for free. Keeping the wrappers
 * here (rather than in `client.ts`) keeps `berd_chat` wiring additive and local
 * to the chat feature.
 */
import { track } from "@/shared/telemetry/client";
import {
  type BerdChatChatSourceSurface,
  berdChatMessageSent,
  berdChatSessionStarted,
  type DistillChatTurnErrorKind,
  distillChatTurnEnded,
  type DistillChatTurnOutcome,
} from "@/shared/telemetry/events";

/**
 * The `source_surface` values this feature emits. These are the exact schema
 * values reachable from the chat controller flows wired here. Detached
 * `session:*` windows run the same controller flows and report MAIN_CHAT;
 * there is no separate session-window surface on the wire.
 */
export const CHAT_SOURCE_SURFACE = {
  MAIN_CHAT: "CHAT_SOURCE_SURFACE_MAIN_CHAT",
  GLOBAL_COMPOSER: "CHAT_SOURCE_SURFACE_GLOBAL_COMPOSER",
  AGENT_BUILDER: "CHAT_SOURCE_SURFACE_AGENT_BUILDER",
} as const satisfies Record<string, BerdChatChatSourceSurface>;

// Optional provider/model only carry signal when configured; drop blanks so we
// never emit an empty-string attribute standing in for "not set".
function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * A chat session begins, fired when the session's first user message is
 * committed to the transcript (a session id already exists at this point).
 * "First" is decided by `chatFirstMessage`, which withholds the event while a
 * session's history has yet to replay rather than call a resumed session new.
 */
export function trackChatSessionStarted({
  sessionId,
  sourceSurface,
  hasProject,
  hasPersona,
  provider,
  model,
}: {
  sessionId: string;
  sourceSurface: BerdChatChatSourceSurface;
  hasProject: boolean;
  hasPersona: boolean;
  provider?: string | null;
  model?: string | null;
}): void {
  track(
    berdChatSessionStarted({
      session_id: sessionId,
      source_surface: sourceSurface,
      has_project: hasProject,
      has_persona: hasPersona,
      provider: nonEmpty(provider),
      model: nonEmpty(model),
    }),
  );
}

/** The user sends a chat message. */
export function trackChatMessageSent({
  sessionId,
  isFirstMessage,
  hasAttachments,
  hasPersona,
  provider,
  model,
}: {
  sessionId: string;
  isFirstMessage: boolean;
  hasAttachments: boolean;
  hasPersona: boolean;
  provider?: string | null;
  model?: string | null;
}): void {
  track(
    berdChatMessageSent({
      session_id: sessionId,
      is_first_message: isFirstMessage,
      has_attachments: hasAttachments,
      has_persona: hasPersona,
      provider: nonEmpty(provider),
      model: nonEmpty(model),
    }),
  );
}

/** The `outcome` values a settled turn can report. */
export const CHAT_TURN_OUTCOME = {
  COMPLETED: "TURN_OUTCOME_COMPLETED",
  CANCELLED: "TURN_OUTCOME_CANCELLED",
  ERROR: "TURN_OUTCOME_ERROR",
} as const satisfies Record<string, DistillChatTurnOutcome>;

/** The `error_kind` values an errored turn can report. */
export const CHAT_TURN_ERROR_KIND = {
  REJECTED_MODEL: "TURN_ERROR_KIND_REJECTED_MODEL",
  PROVIDER_NOT_SET: "TURN_ERROR_KIND_PROVIDER_NOT_SET",
  PAYLOAD_TOO_LARGE: "TURN_ERROR_KIND_PAYLOAD_TOO_LARGE",
  OTHER: "TURN_ERROR_KIND_OTHER",
} as const satisfies Record<string, DistillChatTurnErrorKind>;

/**
 * A turn settles — answered, cancelled, or failed. Fired from the one place
 * every send outcome converges, so the three ways a turn can end are one event
 * with an outcome rather than three call sites that drift apart.
 *
 * No model attribute: the send core is handed a provider but not a model, and
 * `session_id` already joins this to the `berd_chat_message_sent` that carries
 * one. Threading a model down three call sites to duplicate a joinable
 * attribute is not worth the churn.
 */
export function trackChatTurnEnded({
  sessionId,
  outcome,
  messageCommitted,
  hasPersona,
  durationMs,
  errorKind,
  provider,
}: {
  sessionId: string;
  outcome: DistillChatTurnOutcome;
  messageCommitted: boolean;
  hasPersona: boolean;
  durationMs: number;
  errorKind?: DistillChatTurnErrorKind;
  provider?: string | null;
}): void {
  track(
    distillChatTurnEnded({
      session_id: sessionId,
      outcome,
      message_committed: messageCommitted,
      has_persona: hasPersona,
      // Whole milliseconds: `performance.now()` deltas carry sub-millisecond
      // precision that means nothing at turn scale and only widens the payload.
      duration_ms: Math.round(durationMs),
      error_kind: errorKind,
      provider: nonEmpty(provider),
    }),
  );
}
