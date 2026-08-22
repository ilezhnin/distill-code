import { useEffect } from "react";

import { acpGetSessionInfo } from "@/shared/api/acp";
import { mergeAcpSessionInfo } from "@/features/chat/lib/acpSessionMapping";
import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import { updateSessionTitle } from "@/features/chat/stores/chatSessionOperations";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";

import { useConductorGraphStore } from "./conductorGraphStore";
import {
  formatConductorAnswer,
  parseStructuredReport,
} from "./orchestratorReport";
import {
  lastCompletedAssistantSummary,
  reportStatusFromRun,
} from "./runStatus";
import type { RunStatus, SessionNode, StructuredReport } from "./types";

const seenRunningBySession = new Set<string>();

function isWorkingStatus(status: RunStatus): boolean {
  return status === "starting" || status === "running" || status === "waiting";
}

function childHadOperatorIntervention(
  messages: ReturnType<
    typeof useChatStore.getState
  >["messagesBySession"][string],
): boolean {
  return Boolean(
    messages?.some(
      (message) =>
        message.role === "user" &&
        message.metadata?.origin === "operator_direct",
    ),
  );
}

function statusFromRuntime(
  sessionId: string,
  persisted: RunStatus,
  chatState: ReturnType<
    typeof useChatStore.getState
  >["sessionStateById"][string],
  hasAssistantOutput: boolean,
): RunStatus {
  if (!chatState) return persisted;
  if (chatState.chatState === "error") return "failed";
  if (chatState.isRunCancellationPending) return "cancelled";
  if (chatState.chatState === "waiting") {
    seenRunningBySession.add(sessionId);
    return "waiting";
  }
  if (isSessionRunning(chatState.chatState)) {
    seenRunningBySession.add(sessionId);
    return "running";
  }
  if (
    persisted === "completed" ||
    persisted === "failed" ||
    persisted === "cancelled" ||
    persisted === "stopped"
  ) {
    return persisted;
  }
  if (hasAssistantOutput || seenRunningBySession.has(sessionId)) {
    return "completed";
  }
  return persisted === "starting" ? "starting" : persisted;
}

function workersFor(parentSessionId: string): SessionNode[] {
  return useConductorGraphStore
    .getState()
    .getChildren(parentSessionId)
    .filter((node) => node.role === "worker");
}

function deriveOrchestratorStatus(node: SessionNode): RunStatus {
  const workers = workersFor(node.sessionId);
  if (workers.length === 0) return node.status;
  if (workers.some((worker) => isWorkingStatus(worker.status))) {
    return "running";
  }
  if (workers.some((worker) => worker.status === "failed")) {
    return "failed";
  }
  if (workers.some((worker) => worker.status === "cancelled")) {
    return "cancelled";
  }
  if (workers.every((worker) => worker.status === "completed")) {
    return "completed";
  }
  return node.status;
}

function syncChildStatuses(): void {
  const graph = useConductorGraphStore.getState();
  const chat = useChatStore.getState();
  for (const node of Object.values(graph.nodesById)) {
    if (node.role !== "orchestrator" && node.role !== "worker") continue;
    const hasWorkers =
      node.role === "orchestrator" && workersFor(node.sessionId).length > 0;
    if (hasWorkers) continue;
    const runtime = chat.sessionStateById[node.sessionId];
    const messages = chat.messagesBySession[node.sessionId];
    const summary = lastCompletedAssistantSummary(messages);
    const nextStatus = statusFromRuntime(
      node.sessionId,
      node.status,
      runtime,
      Boolean(summary),
    );
    if (nextStatus !== node.status) {
      graph.patchNode(node.sessionId, { status: nextStatus });
    }
    const reportStatus = reportStatusFromRun(nextStatus);
    if (!reportStatus || !node.runId) continue;
    const existing = graph.getReport(node.runId);
    const operatorIntervened = childHadOperatorIntervention(messages);
    if (existing?.publishedToParent) continue;
    if (
      existing?.summary &&
      existing.status === reportStatus &&
      existing.operatorIntervened === operatorIntervened
    ) {
      continue;
    }
    if (
      !summary &&
      nextStatus === "completed" &&
      !seenRunningBySession.has(node.sessionId)
    ) {
      continue;
    }
    const fallback =
      summary ??
      (reportStatus === "failed"
        ? runtime?.error || "The agent failed."
        : reportStatus === "cancelled"
          ? "The agent was cancelled."
          : "The agent finished.");
    graph.attachReport({
      ...parseStructuredReport(node.runId, reportStatus, fallback),
      operatorIntervened,
    });
  }
  for (const node of Object.values(graph.nodesById)) {
    if (node.role !== "orchestrator") continue;
    const nextStatus = deriveOrchestratorStatus(node);
    if (nextStatus !== node.status) {
      graph.patchNode(node.sessionId, { status: nextStatus });
    }
  }
  publishCompletedTurns();
}

function publishCompletedTurns(): void {
  const graph = useConductorGraphStore.getState();
  const chat = useChatStore.getState();
  const groups = new Map<string, SessionNode[]>();
  for (const node of Object.values(graph.nodesById)) {
    if (node.role !== "orchestrator" || !node.parentSessionId) continue;
    const key = `${node.parentSessionId}::${node.anchorMessageId ?? node.runId ?? node.sessionId}`;
    const group = groups.get(key) ?? [];
    group.push(node);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const leaves = group.flatMap((node) => {
      const workers = workersFor(node.sessionId);
      return workers.length > 0 ? workers : [node];
    });
    if (leaves.some((node) => isWorkingStatus(node.status))) continue;
    const results: Array<{ node: SessionNode; report: StructuredReport }> = [];
    let ready = true;
    let alreadyPublished = false;
    for (const node of leaves) {
      const report = node.runId ? graph.getReport(node.runId) : undefined;
      if (!report) {
        ready = false;
        break;
      }
      if (report.publishedToParent) alreadyPublished = true;
      results.push({ node, report });
    }
    if (!ready || alreadyPublished || results.length === 0) continue;
    const parentId = group[0]?.parentSessionId;
    if (!parentId) continue;
    const text = formatConductorAnswer(results);
    if (!text.trim()) continue;
    for (const { report } of results) {
      graph.attachReport({ ...report, publishedToParent: true });
    }
    chat.addMessage(parentId, {
      id: crypto.randomUUID(),
      role: "assistant",
      created: Date.now(),
      content: [{ type: "text", text }],
      metadata: {
        userVisible: true,
        agentVisible: false,
        completionStatus: "completed",
      },
    });
  }
}

function remapPromotedSessions(): void {
  const sessions = useChatSessionStore.getState().sessions;
  const graph = useConductorGraphStore.getState();
  for (const session of sessions) {
    if (
      session.clientSessionId &&
      session.clientSessionId !== session.id &&
      graph.nodesById[session.clientSessionId]
    ) {
      const previous = graph.nodesById[session.clientSessionId];
      graph.remapSessionId(session.clientSessionId, session.id);
      if (previous?.role === "conductor") {
        void updateSessionTitle(session.id, previous.displayName).catch(() => {
          useChatSessionStore.getState().patchSession(session.id, {
            title: previous.displayName,
            userSetName: true,
          });
        });
      }
    }
  }
}

async function hydrateMissingSessions(): Promise<void> {
  const graph = useConductorGraphStore.getState();
  const sessionStore = useChatSessionStore.getState();
  if (!sessionStore.hasHydratedSessions) return;
  for (const node of Object.values(graph.nodesById)) {
    if (sessionStore.getSession(node.sessionId)) continue;
    try {
      const session = await acpGetSessionInfo(node.sessionId);
      useChatSessionStore.setState((state) =>
        mergeAcpSessionInfo(state, session),
      );
    } catch {
      // Session may have been archived or never persisted by ACP.
    }
  }
}

export function useConductorGraphSync(): void {
  useEffect(() => {
    remapPromotedSessions();
    syncChildStatuses();
    void hydrateMissingSessions();

    const unsubGraph = useConductorGraphStore.subscribe(() => {
      syncChildStatuses();
    });
    const unsubChat = useChatStore.subscribe(() => {
      syncChildStatuses();
    });
    const unsubSessions = useChatSessionStore.subscribe((state, previous) => {
      if (state.sessions !== previous.sessions) {
        remapPromotedSessions();
      }
      if (state.hasHydratedSessions && !previous.hasHydratedSessions) {
        void hydrateMissingSessions();
      }
    });

    return () => {
      unsubGraph();
      unsubChat();
      unsubSessions();
    };
  }, []);
}
