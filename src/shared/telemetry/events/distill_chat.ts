// Distill's own event factories. Unlike its siblings in this directory, this
// module is NOT vendored from squareup/message-schemas and has no counterpart
// there — Distill posts to a Distill-owned collector or to nothing at all (see
// `../exporter`), never to a Block gateway, so it is free to define events the
// schema repo does not model. Kept in its own module precisely so
// `./berd_chat` stays a faithful mirror: an event invented here must never look
// like one that exists upstream.
//
// The same wire discipline as the vendored set still applies: no
// user-generated content, no user-derived identifiers, closed enums over free
// strings, and `session_id` as the one per-entity join key.

import type { Event } from "./event";

/** How a turn stopped. */
export type DistillChatTurnOutcome =
  | "TURN_OUTCOME_COMPLETED"
  | "TURN_OUTCOME_CANCELLED"
  | "TURN_OUTCOME_ERROR";

/**
 * Why an errored turn failed, as a closed set. The error *message* is
 * deliberately not on the wire: it is assembled from harness output and can
 * carry file paths, prompt fragments, and other user content.
 */
export type DistillChatTurnErrorKind =
  | "TURN_ERROR_KIND_REJECTED_MODEL"
  | "TURN_ERROR_KIND_PROVIDER_NOT_SET"
  | "TURN_ERROR_KIND_PAYLOAD_TOO_LARGE"
  | "TURN_ERROR_KIND_OTHER";

export interface DistillChatTurnEndedParams {
  /** ID of the chat session. */
  session_id: string;
  /** How the turn stopped. */
  outcome: DistillChatTurnOutcome;
  /**
   * Whether the user message reached the transcript. False means the send
   * failed before committing anything, which is also the case in which no
   * `berd_chat_message_sent` was emitted — so an unpaired turn is identifiable
   * rather than looking like a lost event.
   */
  message_committed: boolean;
  /** Whether the turn ran under a persona/agent. */
  has_persona: boolean;
  /** Wall-clock milliseconds from dispatch to the turn settling. */
  duration_ms: number;
  /** Why the turn failed. Present only when `outcome` is the error variant. */
  error_kind?: DistillChatTurnErrorKind;
  /** AI provider the turn ran on. */
  provider?: string;
}

/**
 * DistillChat · Turn · Ended
 *
 * Tracks when a chat turn settles, whichever way it settles. The catalog
 * covered starting a session and sending a message but stopped there, so a turn
 * that errored or was cancelled left exactly the same trace as one that
 * answered: none. Under `just dev` this event also reaches the terminal and
 * `berd.log` through the `../devLog` tap, which is where it earns its keep —
 * a turn that ends with nothing rendered now says so, with a duration.
 *
 * Compaction runs its own prompt path and is not counted as a turn here.
 */
export function distillChatTurnEnded(
  params: DistillChatTurnEndedParams,
): Event {
  const parameters: Event["parameters"] = {
    session_id: params.session_id,
    outcome: params.outcome,
    message_committed: params.message_committed,
    has_persona: params.has_persona,
    duration_ms: params.duration_ms,
  };
  // Absent optional params are omitted entirely, never serialized as the OTLP
  // empty `value: {}` encoding, so the ingestion gateway's allowlist only ever
  // sees these keys carrying a value.
  if (params.error_kind !== undefined)
    parameters.error_kind = params.error_kind;
  if (params.provider !== undefined) parameters.provider = params.provider;
  return {
    name: "distill_chat_turn_ended",
    parameters,
  };
}
