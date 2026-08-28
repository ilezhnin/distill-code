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
  /**
   * What this agent may spend before the app stops it (P49).
   *
   * Until this existed the only brake on a wave was the operator noticing.
   * A step that started looping cost whatever it cost, and the operator found
   * out from the bill. Whichever ceiling is reached first ends the run, and
   * the run says why in its report rather than simply stopping.
   */
  budget?: NodeBudget;
  /**
   * When this agent is expected to report upwards.
   *
   * `on-completion` is the protocol as built: one report, at the end.
   * `on-milestone` asks for an interim report at each meaningful step, for
   * long-running work whose parent should not wait blind. `on-request` means
   * it reports only when asked — the poke, or a parent that comes looking.
   */
  reportPolicy?: ReportPolicy;
  /**
   * The root request this agent's work belongs to, carried down the tree.
   *
   * The graph already links a node to its parent and to its conductor; this
   * is the identifier that stays the same across a revision, so the work of
   * one operator request can be counted as one thing however many waves it
   * took.
   */
  taskId?: string;
  /**
   * True once the parent has taken the operator's intervention into account.
   *
   * The operator can stop, steer or answer a child directly. Its parent finds
   * out from the report, and until it has said so, "the operator intervened"
   * is a fact about the child that nothing above it has acted on.
   */
  parentAcknowledged?: boolean;
}

export interface NodeBudget {
  /** Dollars, when the provider prices its tokens. */
  usd?: number;
  /** Total tokens across this agent's run. */
  tokens?: number;
  /** Wall-clock minutes since the agent was registered. */
  minutes?: number;
}

export type ReportPolicy = "on-completion" | "on-milestone" | "on-request";

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
