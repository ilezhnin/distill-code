// Chat state machine
export type ChatState =
  | "idle"
  | "thinking"
  | "streaming"
  | "waiting"
  | "compacting"
  | "error";

// Token tracking
export type SessionCostBilling = "estimate" | "billed";

export interface TokenState {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  accumulatedInput: number;
  accumulatedOutput: number;
  accumulatedTotal: number;
  contextLimit: number;
  // Engine-computed session cost in USD (from the ACP usage_update).
  // Null when the provider/model has no resolvable pricing.
  accumulatedCost: number | null;
  /**
   * Whether `accumulatedCost` is an API-list estimate or an actual bill.
   * Null when there is no cost. Missing billed metadata is "estimate".
   */
  costBilling: SessionCostBilling | null;
}

export const INITIAL_TOKEN_STATE: TokenState = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  accumulatedInput: 0,
  accumulatedOutput: 0,
  accumulatedTotal: 0,
  contextLimit: 0,
  accumulatedCost: null,
  costBilling: null,
};

export interface SessionChatRuntime {
  chatState: ChatState;
  tokenState: TokenState;
  hasUsageSnapshot: boolean;
  streamingMessageId: string | null;
  activeRunId: string | null;
  isRunCancellationPending: boolean;
  pendingInterventionBoundary: {
    interventionMessageId: string;
  } | null;
  pendingAssistantProviderId: string | null;
  error: string | null;
  hasUnread: boolean;
}

export const INITIAL_SESSION_CHAT_RUNTIME: SessionChatRuntime = {
  chatState: "idle",
  tokenState: INITIAL_TOKEN_STATE,
  hasUsageSnapshot: false,
  streamingMessageId: null,
  activeRunId: null,
  isRunCancellationPending: false,
  pendingInterventionBoundary: null,
  pendingAssistantProviderId: null,
  error: null,
  hasUnread: false,
};

export type WorkspaceAttachmentKind =
  | "directory"
  | "repository"
  | "git-main-worktree"
  | "git-linked-worktree"
  | "git-detached-checkout"
  | "subdirectory"
  | "non-git-directory";

export type WorkspaceAttachmentSource =
  | "excluded"
  | "inferred"
  | "selected"
  | "created";

export type WorkspaceAttachmentCleanupKind = "branch" | "worktree";

export interface WorkspaceAttachmentLifecycle {
  /** Workspaces the app created itself (and may clean up). `goose` is the
   *  value earlier builds persisted; it is normalized to `distill` on read. */
  owner: "distill";
  cleanup: WorkspaceAttachmentCleanupKind;
  branch?: string | null;
  baseBranch?: string | null;
  repositoryPath?: string | null;
  worktreePath?: string | null;
  createdBranch?: boolean;
}

export interface WorkspaceAttachment {
  id: string;
  path: string;
  kind: WorkspaceAttachmentKind;
  source: WorkspaceAttachmentSource;
  branch?: string | null;
  repositoryPath?: string | null;
  worktreePath?: string | null;
  lifecycle?: WorkspaceAttachmentLifecycle;
  usedByAgent: boolean;
}

// Session
export interface Session {
  id: string;
  title: string;
  projectId?: string | null;
  providerId?: string;
  personaId?: string;
  modelId?: string;
  modelName?: string;
  workingDir?: string | null;
  workspaceAttachments?: WorkspaceAttachment[];
  activeWorkspaceId?: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  archivedAt?: string;
  messageCount: number;
  userSetName?: boolean;
}
