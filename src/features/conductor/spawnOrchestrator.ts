import {
  admitSystemInheritedQueuedMessage,
  createDeferredQueuedMessagePayload,
} from "@/features/chat/lib/admittedSend";
import { acceptFirstSend } from "@/features/chat/lib/firstWorkspaceSend";
import {
  normalizeSessionExecutionTarget,
  type SessionExecutionTarget,
} from "@/features/chat/lib/sessionExecutionTarget";
import { distillctlCrossSessionSendOptions } from "@/features/distillctl/commands/runtime/sessionSend";
import { reconcileSessionRunSettings } from "@/features/chat/lib/runSettingsReconciler";
import {
  normalizeSessionRunSettings,
  type SessionRunSettings,
} from "@/features/chat/lib/sessionRunSettings";
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
import { DEFAULT_HARNESS_ID } from "@/features/providers/curatedProviders";

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
  /**
   * The effort and fast mode the child runs at (P36): a wave step's own
   * fields, else its ranking's.
   *
   * Recorded as the child's run-settings intent, the same record the chat's
   * own controls write, so the one reconciler applies it on every harness and
   * shows a notice where the model cannot honour it. Never a refusal: a
   * session that cannot run at a value keeps the intent and runs anyway.
   */
  runSettings?: SessionRunSettings;
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
    args.executionTarget ??
      parent.executionTarget ?? { harnessId: DEFAULT_HARNESS_ID },
  );
  const project = parent.projectId
    ? useProjectStore
        .getState()
        .projects.find((candidate) => candidate.id === parent.projectId)
    : undefined;

  // P36: the step asked for a model *and* how to run it. They ride in
  // `session/new` with the model, so the bridge opens the child on them and its
  // very first turn runs at the effort and fast mode the step named rather
  // than the harness default.
  const runSettings = normalizeSessionRunSettings(args.runSettings);
  const child = await sessionStore.createSession({
    title: displayName,
    projectId: parent.projectId ?? undefined,
    executionTarget,
    ...(runSettings ? { runSettings } : {}),
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
  // The safety net, before the first prompt is queued below: a bridge that
  // did not take a value at creation gets it from the reconciler, or the
  // child shows why it runs without it.
  if (runSettings) {
    await seedChildRunSettings(child.id, runSettings);
  }
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
    ...(runSettings?.effort ? { effort: runSettings.effort } : {}),
    ...(runSettings?.fast !== undefined ? { fast: runSettings.fast } : {}),
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
      sendOptions: distillctlCrossSessionSendOptions(),
    }),
    { project, queueReady: true },
  );
  if (!accepted.accepted) {
    useChatStore.getState().enqueueTransportReadyMessage(
      child.id,
      admitSystemInheritedQueuedMessage({
        text: childPrompt,
        sendOptions: distillctlCrossSessionSendOptions(),
      }),
    );
  }

  return { sessionId: child.id, runId };
}

/**
 * Makes sure a freshly created child runs at the effort and fast mode it was
 * created with.
 *
 * `createSession` already sent them in `session/new` and recorded them as the
 * child's `desiredRunSettings`. The record is written again here because it is
 * what the reconciler compares every later answer against, and this must not
 * depend on how creation stored it. The reconcile then writes whatever the
 * bridge did not take at creation, and the first send's model apply re-plans
 * from the model's own answer inside the same mutation. A value the model
 * cannot honour stays as intent with a notice, never a failed spawn.
 */
async function seedChildRunSettings(
  sessionId: string,
  runSettings: SessionRunSettings,
): Promise<void> {
  try {
    useChatSessionStore
      .getState()
      .patchSession(sessionId, { desiredRunSettings: runSettings });
    await reconcileSessionRunSettings({ sessionId });
  } catch (error) {
    // The child is created and its prompt is about to be queued: a run
    // setting that could not be recorded costs the setting, not the step.
    console.error(
      `Failed to seed the run settings of wave child ${sessionId}:`,
      error,
    );
  }
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
    harnessId: args.harnessId ?? DEFAULT_HARNESS_ID,
    modelProviderId: args.modelProviderId,
    modelId: args.modelId,
    displayName: args.displayName,
    personaId: args.personaId,
    roleId: args.roleId,
    status: "stopped",
    createdAt: Date.now(),
  });
}
