/**
 * The spawn ACL for the berdctl path (P42).
 *
 * `berdctl session create` / `session fork` create sessions programmatically.
 * Until the wire carried an `actor`, these calls arrived anonymous and the
 * ACL reached them through prompt text alone. Now the CLI reads
 * AGENT_SESSION_ID — injected by goose into every session's shell — and sends
 * it on the call envelope, so the app can resolve who asked and run the same
 * check `spawnConductorChildSession` runs.
 *
 * Semantics, deliberately conservative:
 * - No actor → the operator's own terminal, a deep link, or an app-internal
 *   dispatch. Allowed: the ACL constrains agents, not the person.
 * - Actor that resolves to no conductor-graph node → an ordinary chat's
 *   session. Treated as the operator acting through that chat (allowed) —
 *   the same reading `sessionSpawnPolicyPrompt` gives a personaless chat.
 * - Actor that resolves to a node → enforced exactly like the in-app
 *   chokepoint: role + persona override → `checkSpawnAllowed`, refusal
 *   posted into the actor's own transcript first (D5), then a CommandError.
 *
 * The identity is goose's session id, which is guessable by construction
 * (YYYYMMDD_n). An agent that deliberately exports a different session's id
 * before calling berdctl can still impersonate it; closing that needs a
 * per-session nonce minted in distill-goose and is P42's documented residue.
 * This gate still moves the path from "a sentence in the prompt" to "checked
 * in code for every honest call".
 */

import { useAgentStore } from "@/features/agents/stores/agentStore";
import { personaAgentRefs } from "@/shared/lib/agentSpawns";
import type { Persona } from "@/shared/types/agents";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import { checkSpawnAllowed } from "@/features/conductor/spawnAcl";
import type { RoleLayer } from "@/features/conductor/roleCatalog";
import type { SessionNode, SessionRole } from "@/features/conductor/types";
import { spawnAclDeniedNoticeText } from "@/features/conductor/waveNotices";
import { createSystemNotificationMessage } from "@/shared/types/messages";

import { CommandError } from "../types";

/** The actor's graph node, when the actor names a registered agent session. */
export function actorNode(
  actor: string | null | undefined,
): SessionNode | undefined {
  if (!actor) return undefined;
  return useConductorGraphStore.getState().getNode(actor);
}

/**
 * The layer a fork of `sourceSessionId` lands on: forking a session
 * reproduces a session of the same rank, so the target layer is the source's
 * own role. A source without a node is an ordinary chat and forks as a
 * worker-rank session.
 */
export function forkTargetLayer(sourceSessionId: string): RoleLayer {
  const role: SessionRole | undefined = useConductorGraphStore
    .getState()
    .getNode(sourceSessionId)?.role;
  if (role === "conductor" || role === "orchestrator") return role;
  return "worker";
}

/**
 * The persona a fork of `sourceSessionId` will run: the source node's
 * persona, which the fork inherits with the history. A source without a
 * node or persona forks persona-less.
 */
export function forkTargetPersona(
  sourceSessionId: string,
): Persona | undefined {
  const personaId = useConductorGraphStore
    .getState()
    .getNode(sourceSessionId)?.personaId;
  if (!personaId) return undefined;
  return useAgentStore
    .getState()
    .personas.find((candidate) => candidate.id === personaId);
}

/**
 * Enforces the spawn ACL for one berdctl-created session. Resolves the
 * actor, and when it is a registered agent session, refuses layers outside
 * its effective ACL — posting the refusal into the actor's transcript before
 * throwing, so no caller can turn it into a silent failure (D5).
 */
export function enforceBerdctlSpawnAcl(args: {
  actor: string | null | undefined;
  targetLayer: RoleLayer;
  /** Persona the new session will run, when the call named one. */
  targetPersona?: Persona | null;
}): void {
  const node = actorNode(args.actor);
  if (!node) return;
  const persona = node.personaId
    ? useAgentStore
        .getState()
        .personas.find((candidate) => candidate.id === node.personaId)
    : undefined;
  const check = checkSpawnAllowed({
    initiatorRole: node.role,
    initiatorPersona: persona,
    targetLayer: args.targetLayer,
    targetAgentRefs: args.targetPersona
      ? personaAgentRefs(args.targetPersona)
      : [],
    targetAgentName: args.targetPersona?.displayName,
  });
  if (check.allowed) return;
  const noticeText = spawnAclDeniedNoticeText({
    initiatorName: node.displayName,
    initiatorLayer: check.initiatorRole,
    targetLayer: check.targetLayer,
    allowedLayers: check.allowedLayers,
    refusal: check.refusal,
    allowedAgents: check.allowedAgents,
    targetAgent: check.targetAgent,
  });
  useChatStore
    .getState()
    .addMessage(
      node.sessionId,
      createSystemNotificationMessage(noticeText, "error"),
    );
  throw new CommandError(
    "spawn_not_allowed",
    check.refusal === "agent"
      ? `This session's named allowlist permits starting: ` +
          `${check.allowedAgents && check.allowedAgents.length > 0 ? check.allowedAgents.join(", ") : "no agents"}. ` +
          `Starting "${check.targetAgent ?? "an unnamed agent"}" was refused by the spawn ACL.`
      : `Sessions on the "${check.initiatorRole}" layer may start: ` +
          `${check.allowedLayers.length > 0 ? check.allowedLayers.join(", ") : "nothing"}. ` +
          `Starting a "${check.targetLayer}"-layer session was refused by the spawn ACL.`,
  );
}

/**
 * Registers a berdctl-created session under its actor in the conductor
 * graph, so the next hop's actor lookup finds it and the chain of agents
 * stays visible. Sessions created anonymously stay unregistered — they are
 * the operator's own chats, exactly as before.
 */
export function registerBerdctlChildNode(args: {
  actor: string | null | undefined;
  sessionId: string;
  role: RoleLayer;
  harnessId: string;
  displayName: string;
  personaId?: string;
  task?: string;
}): void {
  const parent = actorNode(args.actor);
  if (!parent) return;
  useConductorGraphStore.getState().registerNode({
    sessionId: args.sessionId,
    projectId: parent.projectId,
    role: args.role,
    managedBy: "agent-cli",
    parentSessionId: parent.sessionId,
    rootConductorId: parent.rootConductorId ?? parent.sessionId,
    runId: crypto.randomUUID(),
    harnessId: args.harnessId,
    displayName: args.displayName,
    personaId: args.personaId,
    status: "starting",
    task: args.task,
    createdAt: Date.now(),
  });
}
