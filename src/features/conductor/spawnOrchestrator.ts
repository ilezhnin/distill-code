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

import { useConductorGraphStore } from "./conductorGraphStore";
import { pickUniqueDisplayName } from "./pickUniqueDisplayName";
import { wrapOrchestratorTaskPrompt } from "./orchestratorReport";
import { pickUniqueScientistName } from "./scientistNames";
import {
  DEFAULT_ORCHESTRATOR_NAME,
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
  const workingDir = parent.workingDir?.trim();
  if (!workingDir) {
    throw new Error("Conductor has no working folder yet.");
  }

  const usedNames = Object.values(
    useConductorGraphStore.getState().nodesById,
  ).map((node) => node.displayName);
  const displayName =
    args.displayName?.trim() ||
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
    ...(args.waveId ? { waveId: args.waveId } : {}),
    ...(typeof args.stepIndex === "number"
      ? { stepIndex: args.stepIndex }
      : {}),
  });

  const childPrompt = args.prompt?.trim() || wrapOrchestratorTaskPrompt(task);
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
