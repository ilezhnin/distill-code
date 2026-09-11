/**
 * Persona handoff for ACP agent harnesses.
 *
 * External ACP agents (Claude Code, Codex, Copilot, Amp, ...) expose no
 * system-prompt channel on `session/new` or `session/prompt`. So we treat
 * *entering an agent* as a handoff: on the first prompt sent under a given
 * (session, provider, persona) we inject the persona instructions once as an
 * assistant-audience content block. Switching the session to a different
 * agent (or a different persona) is a new handoff and re-injects.
 */

/**
 * Tracks which persona handoffs have already been delivered, keyed by
 * session + provider + a fingerprint of the persona/system prompt. Re-keying
 * on the provider means switching agents mid-session re-triggers the handoff.
 */
const deliveredHandoffs = new Set<string>();

function handoffKey(
  sessionId: string,
  providerId: string,
  systemPrompt: string,
): string {
  return `${sessionId}\u0000${providerId}\u0000${fingerprint(systemPrompt)}`;
}

/**
 * Cheap, stable fingerprint of the persona text so editing a persona's prompt
 * counts as a new handoff without storing the full prompt in the key.
 */
function fingerprint(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return `${text.length}:${hash >>> 0}`;
}

/**
 * Frame the handed-off content (app context, persona instructions, or both)
 * as a preamble for the agent.
 */
const PERSONA_HANDOFF_PREAMBLE_PREFIX =
  "You are operating under the following context and instructions for this ";

/**
 * True when `text` is (or starts with) the in-band persona handoff block, so
 * callers can avoid treating it as user-visible prose (bridge-derived titles,
 * snippets, search results).
 */
export function isPersonaHandoffText(text: string): boolean {
  return text.startsWith(PERSONA_HANDOFF_PREAMBLE_PREFIX);
}

export function buildPersonaHandoffPreamble(systemPrompt: string): string {
  return [
    PERSONA_HANDOFF_PREAMBLE_PREFIX +
      "session. Adopt them as your system prompt for the remainder of the " +
      "conversation, even though they arrive in-band:",
    "",
    systemPrompt.trim(),
    "",
    "Follow the context and instructions above for all subsequent turns. Do " +
      "not mention this handoff unless it is relevant to the user's request.",
  ].join("\n");
}

/**
 * Resolve the persona handoff for a send. Returns the preamble text to inject
 * as an assistant-audience block, or `null` when no handoff is needed (nothing
 * to deliver, or already delivered for this handoff).
 */
export interface PersonaHandoffClaim {
  preamble: string;
  markDelivered: () => void;
}

export function preparePersonaHandoff(
  sessionId: string,
  providerId: string | undefined,
  systemPrompt: string | undefined,
  appPreamble?: string | null,
): PersonaHandoffClaim | null {
  if (!providerId) {
    return null;
  }

  const combined = [appPreamble?.trim(), systemPrompt?.trim()]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  if (!combined) {
    return null;
  }

  const key = handoffKey(sessionId, providerId, combined);
  if (deliveredHandoffs.has(key)) {
    return null;
  }
  return {
    preamble: buildPersonaHandoffPreamble(combined),
    markDelivered: () => deliveredHandoffs.add(key),
  };
}

export function claimPersonaHandoff(
  sessionId: string,
  providerId: string | undefined,
  systemPrompt: string | undefined,
  appPreamble?: string | null,
): string | null {
  const claim = preparePersonaHandoff(
    sessionId,
    providerId,
    systemPrompt,
    appPreamble,
  );
  claim?.markDelivered();
  return claim?.preamble ?? null;
}

/**
 * Forget any delivered handoffs for a session so the next send re-injects.
 * Use when a session is reset/forked or its history is cleared.
 */
export function resetPersonaHandoff(sessionId: string): void {
  const prefix = `${sessionId}\u0000`;
  for (const key of deliveredHandoffs) {
    if (key.startsWith(prefix)) {
      deliveredHandoffs.delete(key);
    }
  }
}

/** Test-only: clear all tracked handoffs. */
export function __resetAllPersonaHandoffs(): void {
  deliveredHandoffs.clear();
}
