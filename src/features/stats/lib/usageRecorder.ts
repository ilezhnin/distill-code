import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { TokenState } from "@/shared/types/chat";
import { recordSessionTokens, syncUsageSessions } from "./usageLedger";
import {
  modelIdFromExecutionTarget,
  modelNameFromExecutionTarget,
  providerIdFromExecutionTarget,
} from "./usageProvider";
import type { UsageSessionSource, UsageTokenSnapshot } from "./usageTypes";
import { DEFAULT_HARNESS_ID } from "@/features/providers/curatedProviders";

/**
 * The effort a session is running at — what the bridge reports, not what the
 * operator asked for, since a model that refuses an effort runs at another.
 */
function effortFromSession(session: {
  reasoningEffort?: { currentValue: string };
}): string | null {
  return session.reasoningEffort?.currentValue ?? null;
}

function sourceFromSession(session: {
  id: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  messageCount: number;
  executionTarget?: Parameters<typeof providerIdFromExecutionTarget>[0];
  reasoningEffort?: { currentValue: string };
}): UsageSessionSource {
  return {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastMessageAt: session.lastMessageAt,
    messageCount: session.messageCount,
    providerId: providerIdFromExecutionTarget(session.executionTarget),
    modelId: modelIdFromExecutionTarget(session.executionTarget),
    modelName: modelNameFromExecutionTarget(session.executionTarget),
    effort: effortFromSession(session),
  };
}

export function syncChatSessionsIntoUsageLedger(
  sessions = useChatSessionStore.getState().sessions,
): void {
  syncUsageSessions(sessions.map(sourceFromSession));
}

export function recordAcpSessionUsage(
  sessionId: string,
  snapshot: UsageTokenSnapshot,
): void {
  const session = useChatSessionStore
    .getState()
    .sessions.find((candidate) => candidate.id === sessionId);
  recordSessionTokens(
    sessionId,
    snapshot,
    session
      ? {
          providerId: providerIdFromExecutionTarget(session.executionTarget),
          modelId: modelIdFromExecutionTarget(session.executionTarget),
          modelName: modelNameFromExecutionTarget(session.executionTarget),
          effort: effortFromSession(session),
        }
      : undefined,
  );
}

export function recordLiveTokenState(
  sessionId: string,
  tokenState: TokenState,
): void {
  if (
    tokenState.accumulatedInput <= 0 &&
    tokenState.accumulatedOutput <= 0 &&
    tokenState.accumulatedCost == null
  ) {
    return;
  }
  recordAcpSessionUsage(sessionId, {
    mode: "replace",
    inputTokens: tokenState.accumulatedInput,
    outputTokens: tokenState.accumulatedOutput,
    totalTokens: tokenState.accumulatedInput + tokenState.accumulatedOutput,
    costUsd: tokenState.accumulatedCost,
  });
}

export function syncConductorNodesIntoUsageLedger(
  nodes: ReadonlyArray<{
    sessionId: string;
    harnessId?: string;
    modelId?: string;
    createdAt?: number;
    role: string;
    status: string;
  }>,
): void {
  if (nodes.length === 0) return;
  syncUsageSessions(
    nodes.map((node) => ({
      id: node.sessionId,
      createdAt: new Date(node.createdAt ?? Date.now()).toISOString(),
      updatedAt: new Date(node.createdAt ?? Date.now()).toISOString(),
      lastMessageAt: new Date(node.createdAt ?? Date.now()).toISOString(),
      messageCount: 0,
      started: node.role === "orchestrator" || node.role === "worker",
      providerId: node.harnessId || DEFAULT_HARNESS_ID,
      modelId: node.modelId ?? null,
    })),
  );
}
