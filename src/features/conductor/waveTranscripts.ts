/**
 * "Has the conductor's transcript actually been read yet?" — the question the
 * closed loop has to answer before it may treat a missing digest as proof that
 * the digest was never delivered.
 *
 * `chat.messagesBySession` is a *cache*, not a database. It starts empty, is
 * filled only when a session is activated or sent to, and is evicted once more
 * than `MESSAGE_SESSION_CACHE_LIMIT` sessions are cached. The wave lifecycle
 * runs app-wide, with the conductor chat shut, so for it the common case is
 * "this session's messages were never loaded in this process at all".
 *
 * Reading that empty cache as "the digest is not there" is a false negative
 * with a real cost: a second identical digest (two model turns, and the answer
 * to the first copy discarded, because the verdict anchor moves to the newest
 * marker), or a wave parked in `awaitingVerdict` forever.
 *
 * So the distinction is made explicit here — `loaded` versus `unknown` — and
 * `unknown` makes the caller *wait*, never act. Hydration is requested through
 * `loadSessionMessages`, the same deduplicated, session-scoped replay the chat
 * uses; it does not activate the session and does not steal the operator's
 * view.
 */

import { loadSessionMessages } from "@/features/chat/lib/sessionActivation";
import { hasConversationMessages } from "@/features/chat/lib/sessionReplayReplacement";
import { useChatStore } from "@/features/chat/stores/chatStore";
import type { Message } from "@/shared/types/messages";

/**
 * What is known about a session's transcript right now.
 *
 * `loaded` carries the messages of a transcript that has really been read:
 * one holding at least one message that is not a system notice. Anything else
 * — no key, an empty array, or nothing but the notices a failed load leaves
 * behind — is `unknown`, because none of them can tell a delivered digest from
 * a lost one.
 */
export type ConductorTranscript =
  | { kind: "loaded"; messages: readonly Message[] }
  | { kind: "unknown" };

/**
 * How long to wait before asking again for a transcript whose load resolved
 * without populating the cache (a failed replay, an archived session, a
 * session whose creation is still pending). The tick fires on every streamed
 * token, so an ungated retry would be a replay per token.
 */
export const TRANSCRIPT_HYDRATION_RETRY_MS = 5_000;

/** Sessions whose hydration this process has started but not finished. */
const hydrating = new Set<string>();

/** When the last resolved hydration of a still-empty transcript finished. */
const lastAttemptAt = new Map<string, number>();

function requestHydration(sessionId: string, onHydrated: () => void): void {
  if (hydrating.has(sessionId)) return;
  const last = lastAttemptAt.get(sessionId);
  if (last !== undefined && Date.now() - last < TRANSCRIPT_HYDRATION_RETRY_MS) {
    return;
  }
  hydrating.add(sessionId);
  void (async () => {
    try {
      await loadSessionMessages(sessionId);
    } catch {
      // A transcript that cannot be loaded leaves the wave waiting, which is
      // the safe side of this decision: waiting costs nothing, and re-sending
      // a digest that already landed costs a model turn and a lost answer.
    } finally {
      hydrating.delete(sessionId);
      lastAttemptAt.set(sessionId, Date.now());
      onHydrated();
    }
  })();
}

/**
 * Reads a session's transcript, or says it does not know it yet and starts a
 * load in the background.
 *
 * The witness is a *conversation* message under the cache key, not the key
 * itself. The key's presence used to be enough, and the loader's own failure
 * paths defeated that: a replay judged invalid, or any thrown load error,
 * appends a system notice under this very key — so one failed load turned
 * "never read" into `{loaded, [notice]}`, and the lifecycle then re-delivered a
 * digest whose marker it could not find, or parked a wave and never asked
 * again. A transcript with nothing but system notices in it is exactly as
 * uninformative as a missing one, so it reads as `unknown` and the 5 s backoff
 * paces the retry. The chat's own loader uses the same test to decide whether
 * an activation needs to replay.
 *
 * `onHydrated` is called after a background load settles, so the caller can
 * re-run its own pass instead of waiting for an unrelated store change.
 */
export function readConductorTranscript(
  sessionId: string,
  onHydrated: () => void,
): ConductorTranscript {
  const messages = useChatStore.getState().messagesBySession[sessionId];
  if (messages && hasConversationMessages(messages)) {
    return { kind: "loaded", messages };
  }
  requestHydration(sessionId, onHydrated);
  return { kind: "unknown" };
}

/** True while a hydration started here has not settled. Tests only. */
export function isHydratingTranscriptForTests(sessionId: string): boolean {
  return hydrating.has(sessionId);
}

/** Clears the process-local hydration bookkeeping. Tests only. */
export function resetConductorTranscriptsForTests(): void {
  hydrating.clear();
  lastAttemptAt.clear();
}
