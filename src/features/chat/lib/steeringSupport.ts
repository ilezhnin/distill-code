/**
 * Only expose in-flight steering for the adapter with a host-owned idle
 * fallback. The host also verifies the bridge's advertised capability.
 * Other providers retain ordinary queued input until their turn finishes.
 */
export function supportsSteeringHarness(
  harnessId: string | null | undefined,
): boolean {
  return harnessId === "claude-acp";
}
