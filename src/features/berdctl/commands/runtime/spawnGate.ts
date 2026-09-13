/**
 * The spawn ACL for the berdctl path (P42).
 *
 * `berdctl session create` / `session fork` create sessions programmatically.
 * The CLI sends an `actor` on the call envelope when the harness exports
 * AGENT_SESSION_ID into the session's shell, and this gate then runs the
 * same check `spawnConductorChildSession` runs.
 *
 * Semantics, deliberately conservative:
 * - No actor → the operator's own terminal, a deep link, or an app-internal
 *   dispatch. Allowed: the ACL constrains agents, not the person. Logged to
 *   the app log so the reading is auditable (see below for why it is the
 *   common case).
 * - Actor that resolves to no conductor-graph node → an ordinary chat's
 *   session. Treated as the operator acting through that chat (allowed) —
 *   the same reading `sessionSpawnPolicyPrompt` gives a personaless chat.
 * - Actor that resolves to a node → enforced exactly like the in-app
 *   chokepoint: role + persona override → `checkSpawnAllowed`, refusal
 *   posted into the actor's own transcript first (D5), then a CommandError.
 *
 * What this gate does NOT do today: the built-in agent host never exports
 * AGENT_SESSION_ID — it runs one bridge process per harness, serving every
 * session of that harness, so a process-level env var cannot carry a
 * per-session id. Every production call therefore arrives anonymous and is
 * treated as the operator; the ACL reaches agents through the prompt insert
 * (`formatSpawnPolicyPrompt`), which says so honestly. The actor branch is
 * exercised by tests and by harnesses that do export the variable. Making
 * the identity real needs a per-session token minted by the host and passed
 * to the shell per session (P42's documented residue). Even then, the
 * identity is not secret: an agent that exports another session's id can
 * impersonate it.
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
import { logRendererEvent } from "@/shared/api/rendererLog";
import { createSystemNotificationMessage } from "@/shared/types/messages";

import { CommandError } from "../types";

/**
 * Records an anonymous spawn in the app log (`berd.log`, the same channel
 * the renderer's other diagnostics use). The reading — anonymous is the
 * operator — is a product decision; the log line makes it visible that a
 * session was started without any attributable caller, which with the
 * built-in host is every berdctl spawn.
 */
export function logAnonymousBerdctlSpawn(args: {
  verb: "create" | "fork";
  targetLayer: RoleLayer;
  targetPersonaName?: string;
}): void {
  const target = args.targetPersonaName
    ? `${args.targetLayer} (agent "${args.targetPersonaName}")`
    : args.targetLayer;
  void logRendererEvent(
    "info",
    `[berdctl] session ${args.verb} carried no actor (the agent host does not export AGENT_SESSION_ID); treating the call as the operator and allowing a ${target} session without a spawn ACL check`,
  );
}

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
 * throwing, so no caller can turn it into a silent failure (D5). An
 * anonymous call is allowed as the operator and logged.
 */
export function enforceBerdctlSpawnAcl(args: {
  actor: string | null | undefined;
  /** The spawning verb, named in the anonymous-call log line. */
  verb: "create" | "fork";
  targetLayer: RoleLayer;
  /** Persona the new session will run, when the call named one. */
  targetPersona?: Persona | null;
}): void {
  if (!args.actor) {
    logAnonymousBerdctlSpawn({
      verb: args.verb,
      targetLayer: args.targetLayer,
      targetPersonaName: args.targetPersona?.displayName,
    });
    return;
  }
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
