/**
 * Who may spawn whom, as code.
 *
 * Until this module existed the only thing standing between an agent and
 * `berdctl session create` was a sentence handwritten into most — not all —
 * of the bundled agent files ("do not spawn chats yourself"). Q6 originally
 * kept the rule prompt-only; the operator has since decided to make it
 * mechanical. This module is the single owner of that mechanism:
 *
 * - the per-layer defaults (conductors start orchestrators and workers,
 *   orchestrators start workers, workers and plain chats start nothing);
 * - the per-agent `spawns` frontmatter override (see `Persona.spawns`);
 * - the check the in-app spawn chokepoint (`spawnOrchestrator.ts`) runs
 *   before creating a session — the one spawn path that knows who asked;
 * - the prompt insert that replaces the handwritten sentence, generated from
 *   the same effective ACL so the text can never disagree with the code.
 *
 * `berdctl session create` / `session fork` are enforced too (P42): the CLI
 * reads AGENT_SESSION_ID from the shell env goose injects per session and
 * sends it as `actor` on the call envelope; the commands resolve it to a
 * graph node and run this same check (berdctl runtime/spawnGate.ts). The
 * residue is stated there: the id is guessable, so a deliberately forged
 * env var can still impersonate a session until goose mints a nonce — the
 * gate covers every honest call, not a determined adversary.
 *
 * Operator-initiated actions (UI buttons, the composer) are exempt on
 * purpose: the ACL constrains agents, not the person running the app — and
 * an anonymous or graph-unknown berdctl call reads as the operator for the
 * same reason.
 */

import {
  normalizeAgentRef,
  parseSpawnAgents,
  parseSpawnLayers,
} from "@/shared/lib/agentSpawns";
import type { Persona } from "@/shared/types/agents";

import { useAgentStore } from "@/features/agents/stores/agentStore";
import { personaAgentRefs } from "@/shared/lib/agentSpawns";

import { DEFAULT_SPAWNS_BY_ROLE } from "./aclDefaults";
import { useConductorGraphStore } from "./conductorGraphStore";
import type { RoleLayer } from "./roleCatalog";
import type { SessionRole } from "./types";

/**
 * The per-layer defaults now live in `aclDefaults.ts`, a module with no store
 * imports, so the agent editor can name a default without pulling the
 * conductor graph (and the wave engine behind it) into the agents bundle.
 * Re-exported here because this module is still where the spawn ACL is read
 * from — the table only moved, it did not fork.
 */
export { DEFAULT_SPAWNS_BY_ROLE } from "./aclDefaults";

/**
 * The persona's `spawns` override, re-validated at the point of use.
 *
 * `Persona.spawns` is already validated where sources are mapped, but
 * persona objects are also constructed ad hoc (queued sends build minimal
 * stand-ins); re-parsing here means a hand-built object can never smuggle an
 * unvalidated list into an enforcement decision.
 */
export function personaSpawnsOverride(
  persona: Pick<Persona, "spawns"> | null | undefined,
): readonly RoleLayer[] | undefined {
  if (!persona || persona.spawns === undefined) return undefined;
  return parseSpawnLayers(persona.spawns);
}

/**
 * The persona's `spawns_agents` named allowlist, re-validated at the point
 * of use for the same reason {@link personaSpawnsOverride} re-parses:
 * hand-built persona stand-ins must not smuggle an unvalidated list into an
 * enforcement decision. `undefined` means no name restriction was authored.
 */
export function personaSpawnAgentsOverride(
  persona: Pick<Persona, "spawnsAgents"> | null | undefined,
): readonly string[] | undefined {
  if (!persona || persona.spawnsAgents === undefined) return undefined;
  return parseSpawnAgents(persona.spawnsAgents);
}

/**
 * The layers a session may spawn: its persona's override when one was
 * authored, otherwise its layer's default.
 */
export function effectiveSpawnLayers(
  role: SessionRole,
  persona?: Pick<Persona, "spawns"> | null,
): readonly RoleLayer[] {
  return personaSpawnsOverride(persona) ?? DEFAULT_SPAWNS_BY_ROLE[role];
}

export type SpawnCheck =
  | { allowed: true }
  | {
      allowed: false;
      /** Which axis refused: the layer ACL, or the named-agent allowlist. */
      refusal: "layer" | "agent";
      /** Layer of the session that asked for the spawn. */
      initiatorRole: SessionRole;
      /** Layer it asked to spawn. */
      targetLayer: RoleLayer;
      /** What it was actually allowed to spawn, for the operator notice. */
      allowedLayers: readonly RoleLayer[];
      /** Named allowlist in force, when the refusal came from it. */
      allowedAgents?: readonly string[];
      /** Name the spawn asked for, when it named one. */
      targetAgent?: string;
    };

/**
 * Checks one programmatic spawn attempt against the effective ACL.
 *
 * Two axes, both must pass: the layer (as always), and — when the initiator
 * persona authored `spawns_agents` — the target's name. The named axis is
 * deny-by-default once authored: a target matching none of the list's
 * entries is refused, and so is a spawn that names no agent at all, because
 * an allowlist of named agents with an unnamed escape hatch is not an
 * allowlist. `targetAgentRefs` carries every name the target answers to
 * (file stem, display name, bundled source); absent means the spawn runs no
 * persona.
 */
export function checkSpawnAllowed(args: {
  initiatorRole: SessionRole;
  initiatorPersona?: Pick<Persona, "spawns" | "spawnsAgents"> | null;
  targetLayer: RoleLayer;
  targetAgentRefs?: readonly string[];
  targetAgentName?: string;
}): SpawnCheck {
  const allowedLayers = effectiveSpawnLayers(
    args.initiatorRole,
    args.initiatorPersona,
  );
  if (!allowedLayers.includes(args.targetLayer)) {
    return {
      allowed: false,
      refusal: "layer",
      initiatorRole: args.initiatorRole,
      targetLayer: args.targetLayer,
      allowedLayers,
    };
  }
  const allowedAgents = personaSpawnAgentsOverride(args.initiatorPersona);
  if (allowedAgents === undefined) {
    return { allowed: true };
  }
  const targetRefs = (args.targetAgentRefs ?? []).map(normalizeAgentRef);
  if (targetRefs.some((ref) => allowedAgents.includes(ref))) {
    return { allowed: true };
  }
  return {
    allowed: false,
    refusal: "agent",
    initiatorRole: args.initiatorRole,
    targetLayer: args.targetLayer,
    allowedLayers,
    allowedAgents,
    targetAgent: args.targetAgentName ?? args.targetAgentRefs?.[0],
  };
}

/**
 * Thrown by a spawn chokepoint that refused per the ACL and has ALREADY made
 * the refusal visible to the operator (D5). Callers that would post their own
 * generic failure notice check for this class and stay quiet instead of
 * saying the same thing twice.
 */
export class SpawnAclDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpawnAclDeniedError";
  }
}

/**
 * The sentence every bundled agent used to carry by hand, plus the clause the
 * handwritten copies never had.
 *
 * The legacy wording is kept verbatim as the opening sentence (removing the
 * handwritten copies changed where the text comes from, not what the agents
 * read). The second sentence names the berdctl spawn commands, because the
 * app preamble injected alongside this line advertises them
 * (`src/features/berdctl/appPreamble.ts`) — and since P42 those commands are
 * refused in code too, against the `actor` identity the CLI now sends
 * (berdctl runtime/spawnGate.ts), so the sentence states enforcement rather
 * than substituting for it.
 */
const SPAWN_FORBIDDEN_PROMPT_LINE =
  "Distill starts other agents from the Agents catalog; do not spawn chats yourself. " +
  "That includes the `berdctl session create` and `berdctl session fork` commands " +
  "the Distill app preamble lists — Distill refuses those in code as well.";

/**
 * The prompt insert stating a session's effective spawn permissions.
 *
 * Generated from the same ACL the enforcement reads, so prompt and mechanism
 * cannot drift apart. Empty permissions open with the exact sentence the
 * catalog files used to hardcode; non-empty permissions state what is
 * allowed and that everything else is refused by the app through those
 * mechanisms, not merely discouraged. Both wordings then extend the rule to
 * the berdctl spawn commands, refused in code the same way since P42.
 */
export interface SpawnAgentMenuEntry {
  /** The allowlist entry, as authored (normalized). */
  ref: string;
  /** Display name when the ref resolved to a persona; the ref otherwise. */
  name: string;
  whenToCall?: string;
  requiredInput?: string;
  expectedOutput?: string;
}

/**
 * The named-allowlist menu for one persona: each allowed agent with its
 * contract card, resolved against the live persona catalog. Entries that
 * resolve to no persona still appear by ref — the allowlist names them, and
 * hiding an entry the author wrote would misstate the permission — they
 * just carry no contract.
 */
export function spawnAgentsMenu(
  persona: Pick<Persona, "spawnsAgents"> | null | undefined,
): SpawnAgentMenuEntry[] | undefined {
  const allowed = personaSpawnAgentsOverride(persona);
  if (allowed === undefined) return undefined;
  const personas = useAgentStore.getState().personas;
  return allowed.map((ref) => {
    const match = personas.find((candidate) =>
      personaAgentRefs(candidate).includes(ref),
    );
    if (!match) return { ref, name: ref };
    return {
      ref,
      name: match.displayName,
      ...(match.whenToCall ? { whenToCall: match.whenToCall } : {}),
      ...(match.requiredInput ? { requiredInput: match.requiredInput } : {}),
      ...(match.expectedOutput ? { expectedOutput: match.expectedOutput } : {}),
    };
  });
}

function formatAgentMenuLine(entry: SpawnAgentMenuEntry): string {
  const parts = [`- ${entry.name}`];
  if (entry.whenToCall) parts.push(`  When to call: ${entry.whenToCall}`);
  if (entry.requiredInput) {
    parts.push(`  The task you delegate must include: ${entry.requiredInput}`);
  }
  if (entry.expectedOutput) {
    parts.push(`  It returns: ${entry.expectedOutput}`);
  }
  return parts.join("\n");
}

export function formatSpawnPolicyPrompt(
  layers: readonly RoleLayer[],
  agentMenu?: readonly SpawnAgentMenuEntry[],
): string {
  if (layers.length === 0) {
    return SPAWN_FORBIDDEN_PROMPT_LINE;
  }
  const layersLine = `Through Distill's own mechanisms you may start agents on these layers: ${layers.join(
    ", ",
  )}. Distill refuses any other spawn through those mechanisms in code; do not try to start sessions outside those layers. The same limit applies to \`berdctl session create\` and \`berdctl session fork\`, refused in code the same way.`;
  if (agentMenu === undefined) {
    return layersLine;
  }
  if (agentMenu.length === 0) {
    return `${layersLine}\nBy name you may start no agents at all: your named allowlist is empty, so every programmatic spawn is refused in code.`;
  }
  return [
    layersLine,
    "You may start only these agents, by name — any other agent, and any spawn that names no agent, is refused in code:",
    ...agentMenu.map(formatAgentMenuLine),
  ].join("\n");
}
/**
 * The spawn-policy insert for one session, or `undefined` when the session
 * gets none.
 *
 * A session gets the insert when it runs a persona (the insert replaces the
 * sentence those files used to hardcode) or when it is a conductor-graph
 * node (wave workers carried no persona and previously got no sentence at
 * all — one of the text holes this closes). A plain personaless chat gets
 * nothing: its model spawns only when the operator asks it to, through
 * berdctl on the operator's behalf, and a standing prohibition there would
 * break that operator-initiated flow.
 */
export function sessionSpawnPolicyPrompt(
  sessionId: string | null | undefined,
  persona: Pick<Persona, "spawns" | "spawnsAgents"> | null | undefined,
): string | undefined {
  const nodeRole = sessionId
    ? useConductorGraphStore.getState().nodesById[sessionId]?.role
    : undefined;
  return formatSessionSpawnPolicyPrompt(nodeRole, persona);
}

/**
 * Pure core of {@link sessionSpawnPolicyPrompt}: the caller supplies the
 * session's conductor-graph role (undefined when the session has no node),
 * which is how the React path keeps this reactive via a store selector.
 * The named-agent menu is resolved against the persona catalog at build
 * time — prompts are assembled per send, so a catalog edit lands on the
 * next message, which is when it can matter.
 */
export function formatSessionSpawnPolicyPrompt(
  nodeRole: SessionRole | undefined,
  persona: Pick<Persona, "spawns" | "spawnsAgents"> | null | undefined,
): string | undefined {
  if (nodeRole === undefined && !persona) return undefined;
  return formatSpawnPolicyPrompt(
    effectiveSpawnLayers(nodeRole ?? "plain-chat", persona),
    spawnAgentsMenu(persona),
  );
}
