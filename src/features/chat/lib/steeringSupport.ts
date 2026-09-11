/**
 * Steering — guidance dropped into a turn that is already running — is served
 * by the agent host, not by the bridge: the host queues the steer and drains
 * it at the next turn boundary whichever harness produced the turn. So any
 * session with a harness behind it can be steered; only a session that has
 * not resolved its harness yet cannot.
 */
export function supportsSteeringHarness(
  harnessId: string | null | undefined,
): boolean {
  return typeof harnessId === "string" && harnessId.trim().length > 0;
}
