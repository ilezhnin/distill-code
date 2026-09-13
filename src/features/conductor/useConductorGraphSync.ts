import { useEffect } from "react";

import { acpGetSessionInfo } from "@/shared/api/acp";
import { mergeAcpSessionInfo } from "@/features/chat/lib/acpSessionMapping";
import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { syncConductorDisplayNameFromTitle } from "./syncConductorDisplayName";

import {
  isConductorGraphHydrated,
  useConductorGraphStore,
} from "./conductorGraphStore";
import { publishTerminalGroupDigests } from "./digestPublisher";
import { parseStructuredReport } from "./orchestratorReport";
import { reconcileStaleGraphStatuses } from "./reconcileStaleGraphStatuses";
import {
  lastCompletedAssistantSummary,
  reportStatusFromRun,
} from "./runStatus";
import type { Message } from "@/shared/types/messages";

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
  // One-shot, so it must see the nodes the previous run left: reconciling an
  // empty graph "succeeds", and the stale nodes the folder brings in a moment
  // later would then claim to be working forever.
  if (!isConductorGraphHydrated()) return;
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

/**
 * Memo for the operator-intervention scan, keyed on the transcript array.
 *
 * The pass runs on every chat-store change that could matter — while a reply
 * streams, that is once per token — and this test walked the whole transcript
 * of every node each time. The store replaces the array whenever a transcript
 * changes, so an entry keyed on the array is valid exactly as long as the
 * answer is, and the map lets a replaced array be collected.
 */
const operatorInterventionByTranscript = new WeakMap<
  readonly Message[],
  boolean
>();

function childHadOperatorIntervention(
  messages: ReturnType<
    typeof useChatStore.getState
  >["messagesBySession"][string],
): boolean {
  if (!messages) return false;
  const cached = operatorInterventionByTranscript.get(messages);
  if (cached !== undefined) return cached;
  const intervened = messages.some(
    (message) =>
      message.role === "user" && message.metadata?.origin === "operator_direct",
  );
  operatorInterventionByTranscript.set(messages, intervened);
  return intervened;
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

/**
 * Every orchestrator's workers, in one walk of the graph.
 *
 * `getChildren` filters the whole node map, so asking it per orchestrator made
 * the pass O(nodes x orchestrators) — on a graph at its 500-node bound, on a
 * path that runs while a reply streams. One index per pass answers the same
 * question, and the pass only ever asks about the state it started from.
 */
function indexWorkersByParent(
  nodesById: Readonly<Record<string, SessionNode>>,
): Map<string, SessionNode[]> {
  const byParent = new Map<string, SessionNode[]>();
  for (const node of Object.values(nodesById)) {
    if (node.role !== "worker" || !node.parentSessionId) continue;
    const siblings = byParent.get(node.parentSessionId);
    if (siblings) siblings.push(node);
    else byParent.set(node.parentSessionId, [node]);
  }
  return byParent;
}

const NO_WORKERS: readonly SessionNode[] = [];

function deriveOrchestratorStatus(
  node: SessionNode,
  workersByParent: Map<string, SessionNode[]>,
): RunStatus {
  const workers = workersByParent.get(node.sessionId) ?? NO_WORKERS;
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
  const workersByParent = indexWorkersByParent(graph.nodesById);
  for (const node of Object.values(graph.nodesById)) {
    if (node.role !== "orchestrator" && node.role !== "worker") continue;
    const hasWorkers =
      node.role === "orchestrator" &&
      (workersByParent.get(node.sessionId)?.length ?? 0) > 0;
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
    const nextStatus = deriveOrchestratorStatus(node, workersByParent);
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
  publishTerminalGroupDigests(
    (parentSessionId) => workersByParent.get(parentSessionId) ?? [],
  );
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
      graph.remapSessionId(session.clientSessionId, session.id);
    }
  }
  unlockConductorRolePlaceholderTitles();
  syncConductorTitlesFromSessions();
}

function syncConductorTitlesFromSessions(): void {
  const graph = useConductorGraphStore.getState();
  const sessions = useChatSessionStore.getState();
  for (const node of Object.values(graph.nodesById)) {
    if (node.role !== "conductor") {
      continue;
    }
    const session = sessions.getSession(node.sessionId);
    if (!session) {
      continue;
    }
    syncConductorDisplayNameFromTitle(node.sessionId, session.title);
  }
}

function unlockConductorRolePlaceholderTitles(): void {
  const graph = useConductorGraphStore.getState();
  for (const node of Object.values(graph.nodesById)) {
    if (node.role !== "conductor") {
      continue;
    }
    unlockConductorRolePlaceholderTitle(node.sessionId, node.displayName);
  }
}

/**
 * Older conductors were created as "Producer N" with userSetName, which
 * blocked harness title generation. If the chat title is still that role
 * placeholder, allow the next naming pass to replace it.
 */
function unlockConductorRolePlaceholderTitle(
  sessionId: string,
  displayName: string,
): void {
  const session = useChatSessionStore.getState().getSession(sessionId);
  if (!session?.userSetName) {
    return;
  }
  if (session.title.trim() !== displayName.trim()) {
    return;
  }
  useChatSessionStore.getState().patchSession(sessionId, {
    userSetName: false,
  });
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

    const onStateChanged = () => {
      reconcileStaleStatusesOnce();
      syncChildStatuses();
    };
    // Selected rather than "any change at all". The pass derives statuses and
    // reports from exactly these five slices, while both stores are written for
    // many other reasons — a draft keystroke, a scroll target, a read flag —
    // and the chat store is written per streamed token. Each slice gets its own
    // subscription because zustand compares the selected value with `Object.is`
    // and a tuple of slices would be a new object every time, which is the same
    // as no selector at all.
    const unsubGraphNodes = useConductorGraphStore.subscribe(
      (state) => state.nodesById,
      onStateChanged,
    );
    const unsubGraphReports = useConductorGraphStore.subscribe(
      (state) => state.reportsByRunId,
      onStateChanged,
    );
    const unsubMessages = useChatStore.subscribe(
      (state) => state.messagesBySession,
      onStateChanged,
    );
    const unsubRuntimes = useChatStore.subscribe(
      (state) => state.sessionStateById,
      onStateChanged,
    );
    // The queued first send is what tells the stale-status reconcile that a
    // child with no runtime is about to get one.
    const unsubQueued = useChatStore.subscribe(
      (state) => state.queuedMessageBySession,
      onStateChanged,
    );
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
      unsubGraphNodes();
      unsubGraphReports();
      unsubMessages();
      unsubRuntimes();
      unsubQueued();
      unsubSessions();
    };
  }, []);
}
