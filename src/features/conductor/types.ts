export type SessionRole =
  | "conductor"
  | "orchestrator"
  | "worker"
  | "plain-chat";

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
