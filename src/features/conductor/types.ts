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
  /**
   * First transition into a terminal run status, stamped by `patchNode`.
   * With `createdAt` it is the run's wall-clock duration — the fact wave
   * telemetry records and nothing else was keeping.
   */
  finishedAt?: number;
  anchorMessageId?: string;
  /** Wave that produced this node. Set only for `managedBy: "wave"` children. */
  waveId?: string;
  /** Zero-based index of the wave step this node executes. */
  stepIndex?: number;
}

export interface StructuredReport {
  runId: string;
  /**
   * `completed`/`failed`/`cancelled` mirror the run's own terminal outcomes.
   * `blocked` is different in kind: it is the worker's *claim*, made in its
   * report fence, that the step could not be done at all — a missing input, a
   * contradiction in the instructions, something only the operator can
   * resolve — and that no result was produced or invented. It never comes
   * from a run status; only the report parser writes it.
   */
  status: "completed" | "failed" | "cancelled" | "blocked";
  summary: string;
  /**
   * Why a `blocked` report is blocked, in the worker's own words. Present
   * exactly when `status` is `"blocked"`: the parser synthesizes a stand-in
   * when the worker forgot one, so a blocked report can always say why.
   */
  reason?: string;
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
