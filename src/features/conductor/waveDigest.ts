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
import type { WaveState, WaveVerdictIssue } from "./waveEngine";
import {
  AGENT_DIGEST_INSTRUCTION,
  buildWaveArtifactLine,
  buildWaveDigestInstruction,
  buildWaveStalledLine,
  buildWaveGitDeltaLine,
  buildWaveVerdictRetryInstruction,
  type WaveGitDeltaFacts,
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

/**
 * `<id>#<attempt>` — the shape every marker this app writes has.
 *
 * Checked on top of the envelope parse so a message that merely *looks* like a
 * marker is not mistaken for one.
 */
const DIGEST_KEY_PATTERN = /^[A-Za-z0-9:_-]+#\d+$/;

/**
 * True when this message is a digest envelope delivered into a transcript.
 *
 * Identified by the marker alone, deliberately. Renderer metadata does not
 * survive rehydration from ACP history on any harness but Goose — which is the
 * whole reason the text marker exists — so gating on `metadata.origin` meant
 * that on Claude Code or Codex the digest card silently degraded, after a
 * reload, into a right-aligned user bubble containing the raw instruction and
 * every worker's report. That is precisely the outcome this module was written
 * to prevent.
 *
 * A user message that merely quotes a marker is not turned into a fake digest,
 * because a quote cannot satisfy all three conditions at once: the marker must
 * *open* the message (`parseDigestEnvelope` requires `startsWith`, so anything
 * preceding it — a sentence, a code fence, a `>` — disqualifies it), it must be
 * alone on its first line and match the strict marker syntax (no whitespace, no
 * `]`), and its id must carry the `#<attempt>` suffix the app always writes.
 * Prose that mentions a digest fails the first test; a pasted copy of a real
 * digest passes all three and renders as the card it is a copy of, which is the
 * right answer for it.
 */
export function isDigestMessage(message: Message): boolean {
  if (message.role !== "user") return false;
  const envelope = parseDigestEnvelope(getTextContent(message));
  return envelope !== null && DIGEST_KEY_PATTERN.test(envelope.digestKey);
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
  /```(?:distill-wave|distill-verdict|distill-report|distill-todo|distill-memory)[\s\S]*?```/gi;

/**
 * Removes protocol fences from text that is about to be quoted into a digest.
 *
 * A worker's summary is free-form prose and can quote anything, including a
 * `distill-wave` block. Such a block could never *run* — a digest is a user
 * message and the plan detector only ever scans assistant messages — but the
 * conductor reading the digest is a model, and a plan-shaped block inside a
 * report it is asked to judge is an invitation to echo it back. Ordinary code
 * fences are left exactly as they are; only the protocol tags are cut — the
 * planner's `distill-todo` among them, for the same reason: a digest cannot
 * file a task itself, but a conductor that echoes one back can.
 *
 * `distill-memory` is cut for the sharpest version of that echo: the memory
 * scanner refuses a worker's fence but honors the conductor's, so a memory
 * request smuggled through a report and repeated back by the conductor would
 * be laundered into exactly the write the ACL refused at the source.
 */
export function stripProtocolFences(text: string): string {
  return text.replace(DISTILL_FENCE_PATTERN, "[protocol block removed]").trim();
}

export interface DigestEntry {
  node: Pick<SessionNode, "displayName">;
  report: StructuredReport;
}

/**
 * The E3a facts a wave holds, in the shape the digest builder takes — or
 * `undefined` when the digest-time probe landed no number and there is
 * nothing measured to state.
 */
export function waveGitDeltaOf(
  wave: Pick<WaveState, "gitDirtyAtAdmission" | "gitDirtyAtDigest">,
): WaveGitDeltaFacts | undefined {
  if (wave.gitDirtyAtDigest === undefined) return undefined;
  return {
    digestDirty: wave.gitDirtyAtDigest,
    ...(wave.gitDirtyAtAdmission !== undefined
      ? { admissionDirty: wave.gitDirtyAtAdmission }
      : {}),
  };
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
  /**
   * Why the previous attempt produced no verdict (Q5). Present only on a
   * re-ask of a digest the conductor answered unreadably, and what makes that
   * re-ask a different question from the first. Its *absence* is meaningful
   * too: a wave the operator re-armed for some other reason — an interrupted
   * run that never had a digest at all — must not be told its last answer
   * could not be read, because there was no last answer.
   */
  verdictIssue?: WaveVerdictIssue;
  /**
   * The app's own `git status` measurement (E3a), stated between the
   * instruction and the workers' reports so the conductor reads the one
   * non-model-authored fact before any model's account of itself.
   */
  gitDelta?: WaveGitDeltaFacts;
  /**
   * The app's own answer to "are the files the reports named actually there"
   * (E3b), stated beside the git delta for the same reason: both are facts
   * the conductor should read before any model's account of itself.
   */
  artifacts?: { checked: number; missing: readonly string[] };
  /**
   * The wave was cut short by the stall detector (P61). The digest opens by
   * saying so — the conductor must judge a shortened digest knowingly.
   */
  stalled?: boolean;
}): string {
  return [
    waveDigestMarker(args.waveId, args.attempt),
    args.stalled ? buildWaveStalledLine() : "",
    args.verdictIssue
      ? buildWaveVerdictRetryInstruction(args.verdictIssue)
      : "",
    buildWaveDigestInstruction(args.entries.length),
    args.gitDelta ? buildWaveGitDeltaLine(args.gitDelta) : "",
    args.artifacts ? buildWaveArtifactLine(args.artifacts) : "",
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
