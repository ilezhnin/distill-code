/**
 * The digest envelope: what a finished brigade says to its parent, and how the
 * app recognises that text again later.
 *
 * Everything here is pure. The digest is delivered as a *real user message*
 * through the berdctl cross-session seam (`digestDelivery.ts`), so once it has
 * been sent it is an ordinary transcript message like any other — there is no
 * store that remembers "this message was a digest". A marker in the text is
 * what makes it recognisable again, and it has to earn its keep three times:
 *
 * - **Idempotency.** A digest whose marker is already in the parent transcript
 *   has been delivered; a restart mid-delivery re-checks the transcript instead
 *   of sending a second copy.
 * - **The verdict anchor.** `awaitingVerdict` means "the first settled
 *   assistant message *after this digest*". The marker locates the digest, so
 *   the anchor survives a reload, a rehydration from server history, and any
 *   number of unrelated messages before it.
 * - **Rendering.** `MessageBubble` renders a marked message as a compact card
 *   instead of a normal bubble (combined_plan contract 3). A text marker is the
 *   only carrier that survives rehydration from ACP history, where renderer
 *   metadata does not.
 *
 * The marker carries a delivery attempt, so a manually retried digest (Q5) is a
 * new anchor rather than a second message that collides with the first.
 */

import type { Message } from "@/shared/types/messages";
import { getTextContent } from "@/shared/types/messages";

import { formatConductorAnswer } from "./orchestratorReport";
import type { SessionNode, StructuredReport } from "./types";
import {
  AGENT_DIGEST_INSTRUCTION,
  buildWaveDigestInstruction,
} from "./wavePrompts";

/** Opening of every digest marker. Also the cheap reject before a real parse. */
export const DIGEST_MARKER_PREFIX = "[distill-digest:";

const DIGEST_MARKER_PATTERN = /^\[distill-digest:([^\]\s]+)\]$/;

/** Marker ids must survive the marker syntax: no whitespace, no `]`, no `#`. */
function safeDigestId(value: string): string {
  return value.replace(/[^A-Za-z0-9:_-]/g, "-");
}

/** The marker line for one delivery of one group's digest. */
export function digestMarker(digestId: string, attempt = 0): string {
  return `${DIGEST_MARKER_PREFIX}${safeDigestId(digestId)}#${attempt}]`;
}

/** The marker line for a wave's digest. Waves are grouped by `waveId`. */
export function waveDigestMarker(waveId: string, attempt: number): string {
  return digestMarker(waveId, attempt);
}

export interface DigestEnvelope {
  /** `<id>#<attempt>` exactly as it appeared. */
  digestKey: string;
  /** Everything after the marker line, trimmed. */
  body: string;
}

/**
 * Reads a digest envelope out of a message's text.
 *
 * Returns `null` for anything that does not start with a marker line, which is
 * every ordinary message. Cheap-rejects before touching the regex: this runs
 * once per rendered bubble.
 */
export function parseDigestEnvelope(text: string): DigestEnvelope | null {
  if (!text.startsWith(DIGEST_MARKER_PREFIX)) return null;
  const newline = text.indexOf("\n");
  const markerLine = (newline < 0 ? text : text.slice(0, newline)).trim();
  const match = DIGEST_MARKER_PATTERN.exec(markerLine);
  if (!match) return null;
  return {
    digestKey: match[1],
    body: newline < 0 ? "" : text.slice(newline + 1).trim(),
  };
}

/** True when this message is a digest envelope delivered into a transcript. */
export function isDigestMessage(message: Message): boolean {
  return (
    message.role === "user" &&
    message.metadata?.origin === "berdctl_cross_session" &&
    parseDigestEnvelope(getTextContent(message)) !== null
  );
}

/**
 * Index of the last message carrying `marker`, or `-1`.
 *
 * Last rather than first: a retried digest uses a new marker, but a transcript
 * that somehow holds two copies of the same one is answered by the newest.
 */
export function findDigestMessageIndex(
  messages: readonly Message[] | undefined,
  marker: string,
): number {
  if (!messages?.length) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    if (getTextContent(message).includes(marker)) return index;
  }
  return -1;
}

/**
 * The conductor's answer to a digest: the first settled assistant message that
 * follows it.
 *
 * "Settled" is the same rule the plan detector uses — a message still streaming
 * would be parsed as a broken verdict on every token and immediately fail the
 * whole wave to `needsOperator`, which is not recoverable by waiting.
 */
export function findVerdictMessageAfter(
  messages: readonly Message[] | undefined,
  digestIndex: number,
): Message | undefined {
  if (!messages?.length || digestIndex < 0) return undefined;
  for (let index = digestIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    if (message.metadata?.completionStatus === "inProgress") continue;
    return message;
  }
  return undefined;
}

const DISTILL_FENCE_PATTERN =
  /```(?:distill-wave|distill-verdict|distill-report)[\s\S]*?```/gi;

/**
 * Removes protocol fences from text that is about to be quoted into a digest.
 *
 * A worker's summary is free-form prose and can quote anything, including a
 * `distill-wave` block. Such a block could never *run* — a digest is a user
 * message and the plan detector only ever scans assistant messages — but the
 * conductor reading the digest is a model, and a plan-shaped block inside a
 * report it is asked to judge is an invitation to echo it back. Ordinary code
 * fences are left exactly as they are; only the three protocol tags are cut.
 */
export function stripProtocolFences(text: string): string {
  return text.replace(DISTILL_FENCE_PATTERN, "[protocol block removed]").trim();
}

export interface DigestEntry {
  node: Pick<SessionNode, "displayName">;
  report: StructuredReport;
}

function digestBody(entries: readonly DigestEntry[]): string {
  return stripProtocolFences(formatConductorAnswer([...entries]));
}

/**
 * The digest of one finished wave: one message covering every step, never one
 * message per worker.
 */
export function buildWaveDigest(args: {
  waveId: string;
  attempt: number;
  entries: readonly DigestEntry[];
}): string {
  return [
    waveDigestMarker(args.waveId, args.attempt),
    buildWaveDigestInstruction(args.entries.length),
    digestBody(args.entries),
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

/**
 * The digest of a finished non-wave group (legacy orchestrator trees and
 * agent-cli children). Same envelope, no verdict demanded.
 */
export function buildGroupDigest(args: {
  digestId: string;
  entries: readonly DigestEntry[];
}): string {
  return [
    digestMarker(args.digestId, 0),
    AGENT_DIGEST_INSTRUCTION,
    digestBody(args.entries),
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}
