/**
 * Only expose in-flight steering for adapters with a host-owned idle
 * fallback: Claude Code's, and Kimi Code's with the request Flock adds to it.
 * The host also verifies the bridge's advertised capability, and queues the
 * message where the bridge does not advertise it.
 * Other providers retain ordinary queued input until their turn finishes.
 */
export function supportsSteeringHarness(
  harnessId: string | null | undefined,
): boolean {
  return harnessId === "claude-acp" || harnessId === "kimi-acp";
}
