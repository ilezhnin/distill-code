/**
 * Whether this window is on its way out.
 *
 * The close guard sets it the moment the operator closes the window, before
 * the stores flush and the agent host is told to shut down. Everything that
 * would otherwise read the shutdown as ordinary life checks it — first of all
 * the wave engine, which used to watch the host stop a worker, call the step
 * cancelled and start the next one on the way down: a decision recorded and a
 * session half created, both orphaned when the process ended a second later.
 */
let closing = false;

export function markAppClosing(): void {
  closing = true;
}

/** The close was refused (a flush failed) and the window stays up. */
export function cancelAppClosing(): void {
  closing = false;
}

export function isAppClosing(): boolean {
  return closing;
}

export function resetAppClosingForTests(): void {
  closing = false;
}
