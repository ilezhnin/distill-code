import { create } from "zustand";

import type {
  RunStatus,
  SessionManagedBy,
  SessionNode,
  SessionRole,
  StructuredReport,
} from "./types";
import {
  noteConductorRunStatus,
  remapSessionWorkState,
} from "@/features/stats/lib/usageLedger";
import { syncConductorNodesIntoUsageLedger } from "@/features/stats/lib/usageRecorder";

export const CONDUCTOR_GRAPH_STORAGE_KEY = "goose:conductor-graph";

interface PersistedConductorGraph {
  version: 1;
  nodes: SessionNode[];
  reports: StructuredReport[];
}

interface ConductorGraphState {
  nodesById: Record<string, SessionNode>;
  reportsByRunId: Record<string, StructuredReport>;
}

interface ConductorGraphActions {
  registerNode: (node: SessionNode) => void;
  patchNode: (sessionId: string, patch: Partial<SessionNode>) => void;
  remapSessionId: (fromId: string, toId: string) => void;
  attachReport: (report: StructuredReport) => void;
  getNode: (sessionId: string) => SessionNode | undefined;
  getChildren: (parentSessionId: string) => SessionNode[];
  getReport: (runId: string | null | undefined) => StructuredReport | undefined;
}

export type ConductorGraphStore = ConductorGraphState & ConductorGraphActions;

function isRunStatus(value: unknown): value is RunStatus {
  return (
    value === "starting" ||
    value === "running" ||
    value === "waiting" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "stopped"
  );
}

function isSessionRole(value: unknown): value is SessionRole {
  return (
    value === "conductor" ||
    value === "orchestrator" ||
    value === "worker" ||
    value === "plain-chat"
  );
}

function isSessionManagedBy(value: unknown): value is SessionManagedBy {
  return value === "ui" || value === "wave" || value === "agent-cli";
}

function parseNode(value: unknown): SessionNode | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SessionNode>;
  if (
    typeof raw.sessionId !== "string" ||
    !raw.sessionId ||
    typeof raw.projectId !== "string" ||
    !isSessionRole(raw.role) ||
    typeof raw.displayName !== "string" ||
    typeof raw.harnessId !== "string" ||
    !isRunStatus(raw.status)
  ) {
    return null;
  }
  return {
    sessionId: raw.sessionId,
    projectId: raw.projectId,
    role: raw.role,
    // Migration: graphs persisted before `managedBy` existed load as "ui".
    managedBy: isSessionManagedBy(raw.managedBy) ? raw.managedBy : "ui",
    parentSessionId:
      typeof raw.parentSessionId === "string" ? raw.parentSessionId : null,
    rootConductorId:
      typeof raw.rootConductorId === "string" ? raw.rootConductorId : null,
    runId: typeof raw.runId === "string" ? raw.runId : null,
    harnessId: raw.harnessId,
    modelProviderId:
      typeof raw.modelProviderId === "string" ? raw.modelProviderId : undefined,
    modelId: typeof raw.modelId === "string" ? raw.modelId : undefined,
    displayName: raw.displayName,
    icon: typeof raw.icon === "string" ? raw.icon : undefined,
    personaId: typeof raw.personaId === "string" ? raw.personaId : undefined,
    roleId: typeof raw.roleId === "string" ? raw.roleId : undefined,
    status: raw.status,
    task: typeof raw.task === "string" ? raw.task : undefined,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : undefined,
    anchorMessageId:
      typeof raw.anchorMessageId === "string" ? raw.anchorMessageId : undefined,
    waveId: typeof raw.waveId === "string" ? raw.waveId : undefined,
    stepIndex:
      typeof raw.stepIndex === "number" && Number.isInteger(raw.stepIndex)
        ? raw.stepIndex
        : undefined,
  };
}

function parseReport(value: unknown): StructuredReport | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<StructuredReport>;
  if (
    typeof raw.runId !== "string" ||
    !raw.runId ||
    (raw.status !== "completed" &&
      raw.status !== "failed" &&
      raw.status !== "cancelled") ||
    typeof raw.summary !== "string"
  ) {
    return null;
  }
  return {
    runId: raw.runId,
    status: raw.status,
    summary: raw.summary,
    decisions: Array.isArray(raw.decisions)
      ? raw.decisions.filter((item): item is string => typeof item === "string")
      : [],
    artifacts: Array.isArray(raw.artifacts)
      ? raw.artifacts.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const artifact = item as StructuredReport["artifacts"][number];
          if (typeof artifact.label !== "string") return [];
          return [
            {
              label: artifact.label,
              ...(typeof artifact.path === "string"
                ? { path: artifact.path }
                : {}),
              ...(typeof artifact.url === "string"
                ? { url: artifact.url }
                : {}),
            },
          ];
        })
      : [],
    risks: Array.isArray(raw.risks)
      ? raw.risks.filter((item): item is string => typeof item === "string")
      : [],
    needsOperator: raw.needsOperator === true,
    nextSuggestedTask:
      typeof raw.nextSuggestedTask === "string" ? raw.nextSuggestedTask : null,
    publishedToParent: raw.publishedToParent === true,
    operatorIntervened: raw.operatorIntervened === true,
  };
}

function loadPersistedGraph(): ConductorGraphState {
  if (typeof window === "undefined") {
    return { nodesById: {}, reportsByRunId: {} };
  }
  try {
    const stored = window.localStorage.getItem(CONDUCTOR_GRAPH_STORAGE_KEY);
    if (!stored) return { nodesById: {}, reportsByRunId: {} };
    const parsed = JSON.parse(stored) as PersistedConductorGraph;
    if (parsed.version !== 1) return { nodesById: {}, reportsByRunId: {} };
    const nodesById: Record<string, SessionNode> = {};
    for (const node of parsed.nodes ?? []) {
      const parsedNode = parseNode(node);
      if (parsedNode) nodesById[parsedNode.sessionId] = parsedNode;
    }
    const reportsByRunId: Record<string, StructuredReport> = {};
    for (const report of parsed.reports ?? []) {
      const parsedReport = parseReport(report);
      if (parsedReport) reportsByRunId[parsedReport.runId] = parsedReport;
    }
    return { nodesById, reportsByRunId };
  } catch {
    return { nodesById: {}, reportsByRunId: {} };
  }
}

function persistGraph(state: ConductorGraphState): void {
  if (typeof window === "undefined") return;
  try {
    const payload: PersistedConductorGraph = {
      version: 1,
      nodes: Object.values(state.nodesById),
      reports: Object.values(state.reportsByRunId),
    };
    window.localStorage.setItem(
      CONDUCTOR_GRAPH_STORAGE_KEY,
      JSON.stringify(payload),
    );
  } catch {
    // localStorage may be unavailable
  }
}

function remapId(
  value: string | null | undefined,
  fromId: string,
  toId: string,
): string | null | undefined {
  if (value == null) return value;
  return value === fromId ? toId : value;
}

export const useConductorGraphStore = create<ConductorGraphStore>(
  (set, get) => ({
    ...loadPersistedGraph(),

    registerNode: (node) => {
      set((state) => {
        const next = {
          ...state,
          nodesById: { ...state.nodesById, [node.sessionId]: node },
        };
        persistGraph(next);
        return next;
      });
      try {
        syncConductorNodesIntoUsageLedger([node]);
        if (node.role === "orchestrator" || node.role === "worker") {
          noteConductorRunStatus(node.sessionId, node.status);
        }
      } catch {
        // Usage tracking must never fail graph updates.
      }
    },

    patchNode: (sessionId, patch) => {
      const existing = get().nodesById[sessionId];
      set((state) => {
        const current = state.nodesById[sessionId];
        if (!current) return state;
        const next = {
          ...state,
          nodesById: {
            ...state.nodesById,
            [sessionId]: { ...current, ...patch, sessionId },
          },
        };
        persistGraph(next);
        return next;
      });
      if (patch.status && patch.status !== existing?.status) {
        try {
          noteConductorRunStatus(sessionId, patch.status);
        } catch {
          // Usage tracking must never fail graph updates.
        }
      }
    },

    remapSessionId: (fromId, toId) => {
      if (!fromId || !toId || fromId === toId) return;
      set((state) => {
        const needsRemap =
          Boolean(state.nodesById[fromId]) ||
          Object.values(state.nodesById).some(
            (node) =>
              node.parentSessionId === fromId ||
              node.rootConductorId === fromId,
          );
        if (!needsRemap) {
          return state;
        }
        const nodesById: Record<string, SessionNode> = {};
        for (const node of Object.values(state.nodesById)) {
          const sessionId = node.sessionId === fromId ? toId : node.sessionId;
          nodesById[sessionId] = {
            ...node,
            sessionId,
            parentSessionId:
              remapId(node.parentSessionId, fromId, toId) ?? null,
            rootConductorId:
              remapId(node.rootConductorId, fromId, toId) ?? null,
          };
        }
        const next = { ...state, nodesById };
        persistGraph(next);
        return next;
      });
      remapSessionWorkState(fromId, toId);
    },

    attachReport: (report) => {
      set((state) => {
        const next = {
          ...state,
          reportsByRunId: { ...state.reportsByRunId, [report.runId]: report },
        };
        persistGraph(next);
        return next;
      });
    },

    getNode: (sessionId) => get().nodesById[sessionId],

    getChildren: (parentSessionId) =>
      Object.values(get().nodesById).filter(
        (node) => node.parentSessionId === parentSessionId,
      ),

    getReport: (runId) => (runId ? get().reportsByRunId[runId] : undefined),
  }),
);

export function isConductorSession(
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  return (
    useConductorGraphStore.getState().nodesById[sessionId]?.role === "conductor"
  );
}

/**
 * Legacy orchestrator shells only.
 *
 * These are the ceremonial `managedBy: "ui"` orchestrators the pre-wave
 * auto-spawn created; they were never a real model call and still must not be.
 * Conductor sessions deliberately do *not* match: since 2a a conductor is a
 * real model call that authors its own wave plan.
 */
export function isLegacyOrchestratorShellSession(
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  const node = useConductorGraphStore.getState().nodesById[sessionId];
  return node?.role === "orchestrator" && node.managedBy !== "wave";
}

export function conductorSessionIds(): string[] {
  return Object.values(useConductorGraphStore.getState().nodesById)
    .filter((node) => node.role === "conductor")
    .map((node) => node.sessionId);
}
