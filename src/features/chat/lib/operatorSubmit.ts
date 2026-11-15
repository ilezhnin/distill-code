/**
 * When the operator last sent or steered a message from a chat's composer.
 *
 * A timeline scrolled back into history stays where the reader put it when a
 * message arrives: an agent's report, a monitor's wake-up, a queued message
 * going out minutes after it was typed. The one arrival that takes the reader
 * to the end is their own message right after they sent it, and this is how
 * the timeline tells that one from the rest.
 */
const OPERATOR_SUBMIT_WINDOW_MS = 5_000;

const submittedAtBySession = new Map<string, number>();

export function noteOperatorSubmit(sessionId: string, now = Date.now()): void {
  submittedAtBySession.set(sessionId, now);
}

/** Whether the operator sent from this chat's composer a moment ago. */
export function operatorJustSubmitted(
  sessionId: string,
  now = Date.now(),
): boolean {
  const submittedAt = submittedAtBySession.get(sessionId);
  if (submittedAt === undefined) {
    return false;
  }
  const elapsed = now - submittedAt;
  return elapsed >= 0 && elapsed < OPERATOR_SUBMIT_WINDOW_MS;
}
