import agentAvatar1 from "@/features/agents/assets/icons/agent-avatar-1.png";
import agentAvatar2 from "@/features/agents/assets/icons/agent-avatar-2.png";
import agentAvatar3 from "@/features/agents/assets/icons/agent-avatar-3.png";
import agentAvatar4 from "@/features/agents/assets/icons/agent-avatar-4.png";

// Stable, ordered icon set. Index matches `hash % length`.
const AGENT_ICONS: readonly string[] = [
  agentAvatar1,
  agentAvatar2,
  agentAvatar3,
  agentAvatar4,
];

/**
 * Deterministic DJB2 hash over the persona ID, modulo the icon set length.
 * Same persona ID always resolves to the same icon — gives each persona a
 * stable visual identity without persisting per-persona icon state.
 */
export function resolveAgentIcon(personaId: string): string {
  let hash = 5381;
  for (let i = 0; i < personaId.length; i += 1) {
    // hash * 33 + charCode, kept in 32-bit range via bitwise op
    hash = ((hash << 5) + hash + personaId.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % AGENT_ICONS.length;
  return AGENT_ICONS[index];
}

export const __TEST_ONLY__ = {
  AGENT_ICONS,
};
