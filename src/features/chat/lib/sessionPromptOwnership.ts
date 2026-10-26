const promptOwnerBySession = new Map<string, symbol>();

export function claimSessionPrompt(sessionId: string): symbol {
  const owner = Symbol(sessionId);
  promptOwnerBySession.set(sessionId, owner);
  return owner;
}

export function getSessionPromptOwner(sessionId: string): symbol | null {
  return promptOwnerBySession.get(sessionId) ?? null;
}

export function ownsSessionPrompt(sessionId: string, owner: symbol): boolean {
  return getSessionPromptOwner(sessionId) === owner;
}

export function releaseSessionPrompt(
  sessionId: string,
  owner: symbol,
): boolean {
  if (!ownsSessionPrompt(sessionId, owner)) {
    return false;
  }

  promptOwnerBySession.delete(sessionId);
  return true;
}

/**
 * A turn the host is running that no prompt of this renderer sent: its prompt
 * went out before a reload, or from another frontend. The host's own updates
 * say the work is on, so the renderer adopts the run, owning the session's
 * stream the way a local prompt would, until the host settles it.
 */
const adoptedRunBySession = new Map<string, { runId: string; owner: symbol }>();

/** Adopt `runId` for an unowned session; `false` while a prompt owns it. */
export function adoptSessionRun(sessionId: string, runId: string): boolean {
  if (getSessionPromptOwner(sessionId) !== null) return false;
  adoptedRunBySession.set(sessionId, {
    runId,
    owner: claimSessionPrompt(sessionId),
  });
  return true;
}

/** The adopted run that still owns the session, if any. */
export function adoptedSessionRun(
  sessionId: string,
): { runId: string; owner: symbol } | null {
  const adopted = adoptedRunBySession.get(sessionId);
  if (!adopted) return null;
  if (!ownsSessionPrompt(sessionId, adopted.owner)) {
    // A local prompt took the session over; the adoption is history.
    adoptedRunBySession.delete(sessionId);
    return null;
  }
  return adopted;
}

/** Let go of the adopted run; `true` when it still owned the session. */
export function forgetAdoptedSessionRun(sessionId: string): boolean {
  const adopted = adoptedRunBySession.get(sessionId);
  adoptedRunBySession.delete(sessionId);
  return adopted ? releaseSessionPrompt(sessionId, adopted.owner) : false;
}

export function clearAdoptedSessionRuns(): void {
  for (const sessionId of [...adoptedRunBySession.keys()])
    forgetAdoptedSessionRun(sessionId);
}
