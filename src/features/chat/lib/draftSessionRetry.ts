/**
 * A draft whose creation failed is still a draft: it has no host session, so
 * nothing about it can be written over the wire — a provider or model change
 * sent for its client-generated id is refused by the host every time. What
 * the operator means by choosing another agent or model for such a chat is
 * "try again with this one", and that is what happens: the choice is recorded
 * on the draft and the draft is handed back to the app shell, which owns
 * session creation, to be created on its new target.
 *
 * The shell registers itself here because the picker lives in the chat
 * feature and knows nothing about how sessions are created.
 */

type DraftSessionRetryHandler = (sessionId: string) => boolean;

let retryHandler: DraftSessionRetryHandler | null = null;

export function setDraftSessionRetryHandler(
  handler: DraftSessionRetryHandler | null,
): () => void {
  retryHandler = handler;
  return () => {
    if (retryHandler === handler) {
      retryHandler = null;
    }
  };
}

/**
 * Creates the failed draft again on the target it now has. False when nothing
 * could be retried: no shell is listening, or the chat is not a failed draft.
 */
export function retryDraftSessionCreation(sessionId: string): boolean {
  return retryHandler?.(sessionId) ?? false;
}
