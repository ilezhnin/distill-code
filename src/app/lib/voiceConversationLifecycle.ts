/**
 * When a running voice conversation has to stop because the surface under it
 * changed. Kept out of AppShell.tsx so that file exports only its component:
 * react-refresh gives up on a module that mixes the two, and a chat open
 * across an edit then loses its session state instead of hot-reloading.
 */

export function shouldStopVoiceConversationOnSessionChange({
  previousSessionId,
  nextSessionId,
  boundSessionId,
  lifecycle,
}: {
  previousSessionId: string | null;
  nextSessionId: string | null;
  boundSessionId: string | null;
  lifecycle: string;
}): boolean {
  return (
    previousSessionId !== null &&
    previousSessionId !== nextSessionId &&
    boundSessionId === previousSessionId &&
    lifecycle !== "stopped" &&
    lifecycle !== "unavailable"
  );
}

export function shouldStopVoiceConversationOnExperimentChange({
  wasEnabled,
  isEnabled,
}: {
  wasEnabled: boolean;
  isEnabled: boolean;
}): boolean {
  return wasEnabled && !isEnabled;
}
