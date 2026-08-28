import { useEffect } from "react";

import { acpGetSessionInfo } from "@/shared/api/acp";
import { mergeAcpSessionInfo } from "@/features/chat/lib/acpSessionMapping";
import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import { updateSessionTitle } from "@/features/chat/stores/chatSessionOperations";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";

import { useConductorGraphStore } from "./conductorGraphStore";
import { publishTerminalGroupDigests } from "./digestPublisher";
import { parseStructuredReport } from "./orchestratorReport";
import { reconcileStaleGraphStatuses } from "./reconcileStaleGraphStatuses";
import {
  lastCompletedAssistantSummary,
  reportStatusFromRun,
} from "./runStatus";
import type { RunStatus, SessionNode } from "./types";
import { BoundedSet } from "./boundedSet";
import { runWaveEngineTick } from "./waveRunner";

/** Sessions seen executing at least once. Bounded — see BoundedSet. */
const seenRunningBySession = new BoundedSet(5_000);

/**
 * The startup reconcile is one-shot per app start: module-level, so a remount of
 * the hook (or a second mount in another view) cannot re-stomp nodes that have
 * legitimately gone back to work since.
 */
let hasReconciledStaleStatuses = false;

/**
 * Persisted `starting|running|waiting` nodes survive an app kill forever — the
 * graph has no way to learn that the process that owned them is gone. Once both
 * the sessions and the message queues are hydrated, any orchestrator/worker node
 * that claims to work while it has neither a live runtime nor a queued send that
 * would start it is demoted to `stopped`. `statusFromRuntime` stays authoritative
 * from there: as soon as a real runtime shows up it wins again.
 */
function reconcileStaleStatusesOnce(): void {
  if (hasReconciledStaleStatuses) return;
  if (!useChatSessionStore.getState().hasHydratedSessions) return;
  const chat = useChatStore.getState();
  // Queues hydrate from native storage after the cached snapshot; reconciling
  // earlier could stomp a child whose queued first message is still loading.
  if (!chat.hasHydratedMessageQueues) return;
  hasReconciledStaleStatuses = true;

  const graph = useConductorGraphStore.getState();
  const staleSessionIds = reconcileStaleGraphStatuses(
    Object.values(graph.nodesById),
    {
      sessionStateById: chat.sessionStateById,
      hasQueuedFirstSend: (sessionId) =>
        (chat.queuedMessageBySession[sessionId]?.length ?? 0) > 0,
    },
  );
  for (const sessionId of staleSessionIds) {
    graph.patchNode(sessionId, { status: "stopped" });
  }
}

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

/**
 * Re-entrancy guard for the sync pass.
 *
 * The pass writes to the graph store, and the graph store's own subscription
 * calls the pass — so a write made inside a pass re-enters it. That was
 * survivable only while every write was idempotent; a single report the pass
 * kept re-attaching turned it into unbounded recursion and a renderer crash
 * ("Maximum call stack size exceeded", 2026-08-25).
 *
 * Convergence is still the real contract — a pass must stop writing once it
 * has nothing new to say — but the recursion must not be reachable at all, so
 * nested calls are dropped and answered with at most ONE catch-up pass after
 * the outer one finishes. Bounded on purpose: a loop that ran until the state
 * settled would turn a non-converging write into a hang instead of a crash,
 * which is not an improvement.
 */
let syncing = false;
let syncRequestedWhileRunning = false;

function syncChildStatuses(): void {
  if (syncing) {
    syncRequestedWhileRunning = true;
    return;
  }
  syncing = true;
  try {
    runSyncPass();
    if (syncRequestedWhileRunning) {
      syncRequestedWhileRunning = false;
      runSyncPass();
    }
  } finally {
    syncing = false;
    syncRequestedWhileRunning = false;
  }
}

function runSyncPass(): void {
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
    const next = {
      ...parseStructuredReport(node.runId, reportStatus, fallback),
      operatorIntervened,
    };
    // Compare against the report this pass would write, not against the truth
    // of what is already stored: an existing report whose summary parsed empty
    // is still the same report, and treating it as absent re-attached it on
    // every pass — each write waking the store subscription that runs this
    // pass, until the stack gave out. Status, summary and the intervention
    // flag are the whole derivation: they all come from the same run and the
    // same message text, so equal values mean an identical report.
    if (
      existing &&
      existing.status === next.status &&
      existing.summary === next.summary &&
      existing.operatorIntervened === next.operatorIntervened
    ) {
      continue;
    }
    graph.attachReport(next);
  }
  for (const node of Object.values(graph.nodesById)) {
    if (node.role !== "orchestrator") continue;
    const nextStatus = deriveOrchestratorStatus(node);
    if (nextStatus !== node.status) {
      graph.patchNode(node.sessionId, { status: nextStatus });
    }
  }
  // The engine runs on the statuses and reports this pass just wrote, so a step
  // that went terminal already has its report when an `access: "all"` successor
  // is scheduled, and a wave whose last step just landed builds its digest from
  // the reports of this same pass. Wave children publish through the engine's
  // closed loop; everything else publishes here.
  runWaveEngineTick();
  publishTerminalGroupDigests(workersFor);
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

/**
 * Nodes ACP has already said it does not know about.
 *
 * Without this the loop below asks again for every one of them on every
 * hydration pass, forever: an archived child is permanently missing from the
 * session store, so "missing" is not a condition that ever clears. On a graph
 * carrying a few dozen retired children that is a few dozen IPC round trips
 * per pass, all of them known in advance to fail.
 */
const unknownSessions = new BoundedSet(5_000);

async function hydrateMissingSessions(): Promise<void> {
  const graph = useConductorGraphStore.getState();
  const sessionStore = useChatSessionStore.getState();
  if (!sessionStore.hasHydratedSessions) return;
  const missing = Object.values(graph.nodesById).filter(
    (node) =>
      !sessionStore.getSession(node.sessionId) &&
      !unknownSessions.has(node.sessionId),
  );
  // In parallel: these are independent reads, and awaited one at a time they
  // made startup wait out the sum of every child's round trip.
  await Promise.all(
    missing.map(async (node) => {
      try {
        const session = await acpGetSessionInfo(node.sessionId);
        useChatSessionStore.setState((state) =>
          mergeAcpSessionInfo(state, session),
        );
      } catch {
        // Archived, or never persisted by ACP. Either way, asking again on
        // the next pass would fail the same way.
        unknownSessions.add(node.sessionId);
      }
    }),
  );
}

export function useConductorGraphSync(): void {
  useEffect(() => {
    remapPromotedSessions();
    reconcileStaleStatusesOnce();
    syncChildStatuses();
    void hydrateMissingSessions();

    const unsubGraph = useConductorGraphStore.subscribe(() => {
      syncChildStatuses();
    });
    const unsubChat = useChatStore.subscribe(() => {
      reconcileStaleStatusesOnce();
      syncChildStatuses();
    });
    const unsubSessions = useChatSessionStore.subscribe((state, previous) => {
      if (state.sessions !== previous.sessions) {
        remapPromotedSessions();
      }
      if (state.hasHydratedSessions && !previous.hasHydratedSessions) {
        reconcileStaleStatusesOnce();
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
