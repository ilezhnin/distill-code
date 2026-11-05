/**
 * An expected rejection at the last reversible send boundary. The prompt has
 * not committed local transcript state, so sendCore must leave runtime state
 * untouched for whichever owner currently controls the session.
 */
export class PreCommitSendRejectedError extends Error {}

/**
 * The host already took this message into its session: the app stopped
 * between the host accepting the prompt and the queue letting the record go.
 * The message is in the conversation; the queued copy is stale and is let
 * go, never sent a second time.
 */
export class QueuedMessageAlreadyAcceptedError extends PreCommitSendRejectedError {
  constructor(readonly requestKey: string) {
    super("This message was already accepted by its session.");
    this.name = "QueuedMessageAlreadyAcceptedError";
  }
}

export class QueuedMessageOwnershipLostError extends PreCommitSendRejectedError {
  constructor() {
    super("The queued prompt was canceled.");
    this.name = "QueuedMessageOwnershipLostError";
  }
}
