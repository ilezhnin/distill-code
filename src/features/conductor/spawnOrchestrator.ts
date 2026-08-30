import {
  admitSystemInheritedQueuedMessage,
  createDeferredQueuedMessagePayload,
} from "@/features/chat/lib/admittedSend";
import { acceptFirstSend } from "@/features/chat/lib/firstWorkspaceSend";
import {
  normalizeSessionExecutionTarget,
  type SessionExecutionTarget,
} from "@/features/chat/lib/sessionExecutionTarget";
import { berdctlCrossSessionSendOptions } from "@/features/berdctl/commands/runtime/sessionSend";
import { updateSessionTitle } from "@/features/chat/stores/chatSessionOperations";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";

import { useAgentStore } from "@/features/agents/stores/agentStore";
import { personaAgentRefs } from "@/shared/lib/agentSpawns";
import { createSystemNotificationMessage } from "@/shared/types/messages";

import { useConductorGraphStore } from "./conductorGraphStore";
import { pickUniqueDisplayName } from "./pickUniqueDisplayName";
import { wrapOrchestratorTaskPrompt } from "./orchestratorReport";
import { pickUniqueScientistName } from "./scientistNames";
import { checkSpawnAllowed, SpawnAclDeniedError } from "./spawnAcl";
import { spawnAclDeniedNoticeText } from "./waveNotices";
import {
  DEFAULT_ORCHESTRATOR_NAME,
  type NodeBudget,
  type SessionManagedBy,
  type SessionRole,
} from "./types";

export async function spawnConductorChildSession(args: {
  parentSessionId: string;
  role: Extract<SessionRole, "orchestrator" | "worker">;
  displayName?: string;
  personaId?: string;
  personaName?: string;
  roleId?: string;
  task: string;
  prompt?: string;
  executionTarget?: SessionExecutionTarget;
  anchorMessageId?: string | null;
  /** Which machine owns the child. Defaults to the UI heuristics. */
  managedBy?: SessionManagedBy;
  /** Wave that produced the child; required for `managedBy: "wave"`. */
  waveId?: string;
  /** Zero-based wave step the child executes. */
  stepIndex?: number;
  /** What the child may spend before the app stops it (P49). */
  budget?: NodeBudget;
  /** The root request this child's work belongs to (P49). */
  taskId?: string;
}): Promise<{ sessionId: string; runId: string }> {
  const task = args.task.trim();
  if (!task) {
    throw new Error("An orchestrator task is required.");
  }

  const sessionStore = useChatSessionStore.getState();
  const parent = sessionStore.getSession(args.parentSessionId);
  if (!parent) {
    throw new Error("Conductor session is not available.");
  }
  if (parent.creationState === "pending") {
    throw new Error("Wait for the conductor session to finish starting.");
  }

  // Spawn ACL (see spawnAcl.ts): every programmatic spawn goes through this
  // function, so this is the chokepoint where the initiator's permissions
  // are enforced in code rather than trusted to prompt text. Checked before
  // anything is created, so a refusal costs nothing to roll back.
  const graph = useConductorGraphStore.getState();
  const initiatorNode =
    graph.getNode(args.parentSessionId) ??
    (parent.clientSessionId
      ? graph.getNode(parent.clientSessionId)
      : undefined);
  // A wave spawn whose conductor node is momentarily unmapped (the draft-id
  // remap races the engine tick) is still conductor-initiated: waves are only
  // ever admitted from a registered conductor node. Every other node-less
  // parent is an ordinary chat, which spawns nothing programmatically.
  const initiatorRole: SessionRole =
    initiatorNode?.role ??
    (args.managedBy === "wave" ? "conductor" : "plain-chat");
  const initiatorPersonaId = initiatorNode?.personaId ?? parent.personaId;
  // A persona the store has not hydrated yields no override and the layer
  // default applies — the same permissions the session had before overrides
  // existed, never a silently widened set.
  const initiatorPersona = initiatorPersonaId
    ? useAgentStore
        .getState()
        .personas.find((persona) => persona.id === initiatorPersonaId)
    : undefined;
  // The target's identity for the named allowlist: the persona the spawn
  // names, or — when it names only a catalog role — that role's id, which is
  // what an allowlist author writes for a persona-less step.
  const targetPersona = args.personaId
    ? useAgentStore
        .getState()
        .personas.find((persona) => persona.id === args.personaId)
    : undefined;
  const targetAgentRefs = targetPersona
    ? personaAgentRefs(targetPersona)
    : [args.roleId, args.personaName]
        .filter((ref): ref is string => Boolean(ref?.trim()))
        .map((ref) => ref.trim());
  const aclCheck = checkSpawnAllowed({
    initiatorRole,
    initiatorPersona,
    targetLayer: args.role,
    targetAgentRefs,
    targetAgentName:
      targetPersona?.displayName ?? args.personaName ?? args.roleId,
  });
  if (!aclCheck.allowed) {
    // D5: the refusal is posted where the operator is already looking (the
    // initiator's own transcript) BEFORE the throw, so no caller can turn it
    // into a silent failure.
    const noticeText = spawnAclDeniedNoticeText({
      initiatorName: initiatorNode?.displayName ?? parent.title,
      initiatorLayer: aclCheck.initiatorRole,
      targetLayer: aclCheck.targetLayer,
      allowedLayers: aclCheck.allowedLayers,
      refusal: aclCheck.refusal,
      allowedAgents: aclCheck.allowedAgents,
      targetAgent: aclCheck.targetAgent,
    });
    useChatStore
      .getState()
      .addMessage(
        args.parentSessionId,
        createSystemNotificationMessage(noticeText, "error"),
      );
    throw new SpawnAclDeniedError(noticeText);
  }

  const workingDir = parent.workingDir?.trim();
  if (!workingDir) {
    throw new Error("Conductor has no working folder yet.");
  }

  const usedNames = Object.values(
    useConductorGraphStore.getState().nodesById,
  ).map((node) => node.displayName);
  // A caller-provided display name is still uniquified: two wave steps over
  // the same file would otherwise produce two identical "Scout · foo" tabs.
  const displayName =
    (args.displayName?.trim()
      ? pickUniqueDisplayName(args.displayName.trim(), usedNames)
      : undefined) ||
    pickUniqueDisplayName(
      args.personaName?.trim() || DEFAULT_ORCHESTRATOR_NAME,
      usedNames,
    ) ||
    pickUniqueScientistName(usedNames) ||
    DEFAULT_ORCHESTRATOR_NAME;
  const executionTarget = normalizeSessionExecutionTarget(
    args.executionTarget ?? parent.executionTarget ?? { harnessId: "goose" },
  );
  const project = parent.projectId
    ? useProjectStore
        .getState()
        .projects.find((candidate) => candidate.id === parent.projectId)
    : undefined;

  const child = await sessionStore.createSession({
    title: displayName,
    projectId: parent.projectId ?? undefined,
    executionTarget,
    workingDir,
    workspaceAttachments: parent.workspaceAttachments,
    deferProviderSetup: false,
    personaId: args.personaId,
  });

  sessionStore.patchSession(child.id, {
    title: displayName,
    userSetName: true,
    ...(args.personaId ? { personaId: args.personaId } : {}),
  });
  void updateSessionTitle(child.id, displayName).catch(() => {
    useChatSessionStore.getState().patchSession(child.id, {
      title: displayName,
      userSetName: true,
    });
  });

  const runId = crypto.randomUUID();
  const conductor =
    useConductorGraphStore.getState().getNode(args.parentSessionId) ??
    (parent.clientSessionId
      ? useConductorGraphStore.getState().getNode(parent.clientSessionId)
      : undefined);
  const rootConductorId =
    conductor?.rootConductorId ?? conductor?.sessionId ?? args.parentSessionId;
  useConductorGraphStore.getState().registerNode({
    sessionId: child.id,
    projectId: parent.projectId ?? conductor?.projectId ?? "",
    role: args.role,
    managedBy: args.managedBy ?? "ui",
    parentSessionId: args.parentSessionId,
    rootConductorId,
    runId,
    harnessId: executionTarget.harnessId,
    modelProviderId: executionTarget.modelProviderId,
    modelId: executionTarget.modelId,
    displayName,
    personaId: args.personaId,
    roleId: args.roleId,
    status: "starting",
    task,
    createdAt: Date.now(),
    anchorMessageId: args.anchorMessageId?.trim() || undefined,
    ...(args.budget ? { budget: args.budget } : {}),
    ...(args.taskId ? { taskId: args.taskId } : {}),
    ...(args.waveId ? { waveId: args.waveId } : {}),
    ...(typeof args.stepIndex === "number"
      ? { stepIndex: args.stepIndex }
      : {}),
  });

  const baseChildPrompt =
    args.prompt?.trim() || wrapOrchestratorTaskPrompt(task);
  // The agent's own contract card travels with the task: what it promised
  // to return is part of the delegation, not a fact only its caller knows.
  const childPrompt = targetPersona?.expectedOutput
    ? `${baseChildPrompt}\n\nYour agent card promises this output; deliver it:\n${targetPersona.expectedOutput}`
    : baseChildPrompt;
  const persona = args.personaId
    ? {
        kind: "persona" as const,
        id: args.personaId,
        name: args.personaName?.trim() || displayName,
      }
    : { kind: "inherit" as const };
  const accepted = acceptFirstSend(
    child.id,
    createDeferredQueuedMessagePayload({
      text: childPrompt,
      persona,
      sendOptions: berdctlCrossSessionSendOptions(),
    }),
    { project, queueReady: true },
  );
  if (!accepted.accepted) {
    useChatStore.getState().enqueueTransportReadyMessage(
      child.id,
      admitSystemInheritedQueuedMessage({
        text: childPrompt,
        sendOptions: berdctlCrossSessionSendOptions(),
      }),
    );
  }

  return { sessionId: child.id, runId };
}

export function registerConductorSession(args: {
  sessionId: string;
  projectId: string;
  displayName: string;
  harnessId?: string;
  modelProviderId?: string;
  modelId?: string;
  personaId?: string;
  roleId?: string;
}): void {
  const existing = useConductorGraphStore.getState().getNode(args.sessionId);
  if (existing?.role === "conductor") {
    useConductorGraphStore.getState().patchNode(args.sessionId, {
      projectId: args.projectId,
      displayName: args.displayName,
      harnessId: args.harnessId ?? existing.harnessId,
      modelProviderId: args.modelProviderId ?? existing.modelProviderId,
      modelId: args.modelId ?? existing.modelId,
      personaId: args.personaId ?? existing.personaId,
      roleId: args.roleId ?? existing.roleId,
    });
    return;
  }
  useConductorGraphStore.getState().registerNode({
    sessionId: args.sessionId,
    projectId: args.projectId,
    role: "conductor",
    managedBy: "ui",
    parentSessionId: null,
    rootConductorId: args.sessionId,
    runId: null,
    harnessId: args.harnessId ?? "goose",
    modelProviderId: args.modelProviderId,
    modelId: args.modelId,
    displayName: args.displayName,
    personaId: args.personaId,
    roleId: args.roleId,
    status: "stopped",
    createdAt: Date.now(),
  });
}
