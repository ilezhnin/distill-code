/**
 * Which chats this renderer has loaded the transcript of.
 *
 * Messages in the store are not proof that a transcript was loaded. Live
 * traffic for a chat the renderer has not opened — an agent still answering
 * when the window was reloaded — rebuilds the agent's replies in the store
 * with none of the operator's messages, and a loader that read "has
 * messages" as "is loaded" skipped its replay: the chat opened onto the
 * agent's half of the conversation and stayed that way, whichever chat was
 * opened in between, until a send prepared the session (that load runs as a
 * replay) or the app was restarted. The activation loader now skips a replay
 * only for a chat recorded here.
 *
 * A chat is recorded when a replay has written its transcript, by either
 * loader, and forgotten when the store releases its messages, so a chat that
 * later fills with live traffic again is loaded again.
 */
const hydratedSessionIds = new Set<string>();

export function isTranscriptHydrated(sessionId: string): boolean {
  return hydratedSessionIds.has(sessionId);
}

export function markTranscriptHydrated(sessionId: string): void {
  hydratedSessionIds.add(sessionId);
}

export function clearTranscriptHydration(sessionId: string): void {
  hydratedSessionIds.delete(sessionId);
}

export function resetTranscriptHydrationForTests(): void {
  hydratedSessionIds.clear();
}
