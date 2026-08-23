export type SessionRole =
  | "conductor"
  | "orchestrator"
  | "worker"
  | "plain-chat";

/**
 * Which machine owns a session node's lifecycle.
 *
 * - `ui` — spawned/registered by the current UI heuristics (also the migration
 *   default for graphs persisted before this field existed).
 * - `wave` — owned by the wave engine; only these nodes are driven by it.
 * - `agent-cli` — registered from outside the UI (berdctl).
 */
export type SessionManagedBy = "ui" | "wave" | "agent-cli";

export type RunStatus =
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "stopped";

export interface SessionNode {
  sessionId: string;
  projectId: string;
  role: SessionRole;
  managedBy: SessionManagedBy;
  parentSessionId: string | null;
  rootConductorId: string | null;
  runId: string | null;
  harnessId: string;
  modelProviderId?: string;
  modelId?: string;
  displayName: string;
  icon?: string;
  personaId?: string;
  roleId?: string;
  status: RunStatus;
  task?: string;
  createdAt?: number;
  anchorMessageId?: string;
  /** Wave that produced this node. Set only for `managedBy: "wave"` children. */
  waveId?: string;
  /** Zero-based index of the wave step this node executes. */
  stepIndex?: number;
}

export interface StructuredReport {
  runId: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  decisions: string[];
  artifacts: Array<{ label: string; path?: string; url?: string }>;
  risks: string[];
  needsOperator: boolean;
  nextSuggestedTask: string | null;
  publishedToParent?: boolean;
  operatorIntervened?: boolean;
}

export const CONDUCTOR_CHAT_TITLE = "Conductor";
export const DEFAULT_ORCHESTRATOR_NAME = "Atlas";
