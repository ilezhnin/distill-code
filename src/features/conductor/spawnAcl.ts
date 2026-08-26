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
 * - the check every PROGRAMMATIC spawn path runs before creating a session;
 * - the prompt insert that replaces the handwritten sentence, generated from
 *   the same effective ACL so the text can never disagree with the code.
 *
 * Operator-initiated actions (UI buttons, the composer) are exempt on
 * purpose: the ACL constrains agents, not the person running the app.
 */

import { parseSpawnLayers } from "@/shared/lib/agentSpawns";
import type { Persona } from "@/shared/types/agents";

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
      /** Layer of the session that asked for the spawn. */
      initiatorRole: SessionRole;
      /** Layer it asked to spawn. */
      targetLayer: RoleLayer;
      /** What it was actually allowed to spawn, for the operator notice. */
      allowedLayers: readonly RoleLayer[];
    };

/** Checks one programmatic spawn attempt against the effective ACL. */
export function checkSpawnAllowed(args: {
  initiatorRole: SessionRole;
  initiatorPersona?: Pick<Persona, "spawns"> | null;
  targetLayer: RoleLayer;
}): SpawnCheck {
  const allowedLayers = effectiveSpawnLayers(
    args.initiatorRole,
    args.initiatorPersona,
  );
  if (allowedLayers.includes(args.targetLayer)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    initiatorRole: args.initiatorRole,
    targetLayer: args.targetLayer,
    allowedLayers,
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
 * The sentence every bundled agent used to carry by hand, verbatim. Kept
 * byte-identical so removing the handwritten copies changes where the text
 * comes from, not what the agents read.
 */
const SPAWN_FORBIDDEN_PROMPT_LINE =
  "Distill starts other agents from the Agents catalog; do not spawn chats yourself.";

/**
 * The prompt insert stating a session's effective spawn permissions.
 *
 * Generated from the same ACL the enforcement reads, so prompt and mechanism
 * cannot drift apart. Empty permissions produce the exact sentence the
 * catalog files used to hardcode; non-empty permissions state what is
 * allowed and that everything else is refused by the app, not merely
 * discouraged.
 */
export function formatSpawnPolicyPrompt(layers: readonly RoleLayer[]): string {
  if (layers.length === 0) {
    return SPAWN_FORBIDDEN_PROMPT_LINE;
  }
  return `Through Distill's own mechanisms you may start agents on these layers: ${layers.join(
    ", ",
  )}. Distill refuses any other spawn in code; do not try to start sessions outside those layers.`;
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
  persona: Pick<Persona, "spawns"> | null | undefined,
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
 */
export function formatSessionSpawnPolicyPrompt(
  nodeRole: SessionRole | undefined,
  persona: Pick<Persona, "spawns"> | null | undefined,
): string | undefined {
  if (nodeRole === undefined && !persona) return undefined;
  return formatSpawnPolicyPrompt(
    effectiveSpawnLayers(nodeRole ?? "plain-chat", persona),
  );
}
