import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { useAgentStore } from "@/features/agents/stores/agentStore";
import type { SessionExecutionTarget } from "@/features/chat/lib/sessionExecutionTarget";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { getTextContent, type Message } from "@/shared/types/messages";

import { useConductorGraphStore } from "./conductorGraphStore";
import {
  wrapOrchestratorCoordinationPrompt,
  wrapOrchestratorTaskPrompt,
} from "./orchestratorReport";
import { pickUniqueDisplayName } from "./pickUniqueDisplayName";
import { planOrchestratorTasks } from "./planOrchestratorTasks";
import { selectRoleForTask } from "./roleCatalog";
import { spawnConductorChildSession } from "./spawnOrchestrator";
import { userMessagesNeedingOrchestrator } from "./userMessagesNeedingOrchestrator";

function usedDisplayNames(): string[] {
  return Object.values(useConductorGraphStore.getState().nodesById).map(
    (node) => node.displayName,
  );
}

export function useConductorAutoSpawn({
  sessionId,
  enabled,
  isHydrating,
  messages,
  executionTarget,
}: {
  sessionId: string | null | undefined;
  enabled: boolean;
  isHydrating: boolean;
  messages: readonly Message[];
  executionTarget?: SessionExecutionTarget;
}): void {
  const hydratedUserMessageIdsRef = useRef<Set<string> | null>(null);
  const inFlightRef = useRef(new Set<string>());
  const sessionIdRef = useRef(sessionId);
  if (sessionIdRef.current !== sessionId) {
    sessionIdRef.current = sessionId;
    hydratedUserMessageIdsRef.current = null;
    inFlightRef.current = new Set();
  }

  const childAnchorMessageIds = useConductorGraphStore(
    useShallow((state) =>
      Object.values(state.nodesById)
        .filter(
          (node) =>
            node.parentSessionId === sessionId &&
            (node.role === "orchestrator" || node.role === "worker") &&
            Boolean(node.anchorMessageId),
        )
        .map((node) => node.anchorMessageId as string),
    ),
  );

  useEffect(() => {
    if (!enabled || !sessionId || isHydrating) {
      return;
    }

    if (hydratedUserMessageIdsRef.current === null) {
      hydratedUserMessageIdsRef.current = new Set(
        messages
          .filter((message) => message.role === "user")
          .map((message) => message.id),
      );
      return;
    }

    const parent = useChatSessionStore.getState().getSession(sessionId);
    if (
      !parent ||
      parent.creationState === "pending" ||
      !parent.workingDir?.trim()
    ) {
      return;
    }

    const needed = userMessagesNeedingOrchestrator({
      messages,
      hydratedUserMessageIds: hydratedUserMessageIdsRef.current,
      childAnchorMessageIds: new Set(childAnchorMessageIds),
    });

    for (const message of needed) {
      if (inFlightRef.current.has(message.id)) continue;
      const tasks = planOrchestratorTasks(getTextContent(message).trim());
      if (tasks.length === 0) continue;
      inFlightRef.current.add(message.id);
      hydratedUserMessageIdsRef.current.add(message.id);
      void (async () => {
        try {
          const personas = useAgentStore.getState().personas;
          for (const task of tasks) {
            const names = usedDisplayNames();
            const orchestratorPick = selectRoleForTask(
              task,
              "orchestrator",
              personas,
            );
            const workerPick = selectRoleForTask(task, "worker", personas);
            const orchestratorName = pickUniqueDisplayName(
              orchestratorPick.persona?.displayName ??
                orchestratorPick.role.displayName,
              names,
            );
            names.push(orchestratorName);
            const workerName = pickUniqueDisplayName(
              workerPick.persona?.displayName ?? workerPick.role.displayName,
              names,
            );
            const orchestrator = await spawnConductorChildSession({
              parentSessionId: sessionId,
              role: "orchestrator",
              displayName: orchestratorName,
              personaId: orchestratorPick.persona?.id,
              personaName:
                orchestratorPick.persona?.displayName ??
                orchestratorPick.role.displayName,
              roleId: orchestratorPick.role.id,
              task,
              prompt: wrapOrchestratorCoordinationPrompt(task, workerName),
              executionTarget,
              anchorMessageId: message.id,
            });
            await spawnConductorChildSession({
              parentSessionId: orchestrator.sessionId,
              role: "worker",
              displayName: workerName,
              personaId: workerPick.persona?.id,
              personaName:
                workerPick.persona?.displayName ?? workerPick.role.displayName,
              roleId: workerPick.role.id,
              task,
              prompt: wrapOrchestratorTaskPrompt(task),
              executionTarget,
              anchorMessageId: message.id,
            });
          }
        } catch (error) {
          console.error("Failed to auto-start orchestrator:", error);
        } finally {
          inFlightRef.current.delete(message.id);
        }
      })();
    }
  }, [
    childAnchorMessageIds,
    enabled,
    executionTarget,
    isHydrating,
    messages,
    sessionId,
  ]);
}
