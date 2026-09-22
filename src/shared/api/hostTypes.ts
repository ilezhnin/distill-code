/**
 * Wire types for the host extension methods (`_distill/...`) served by the
 * Tauri agent host. Core ACP types come from `@agentclientprotocol/sdk`.
 */

export type SourceType =
  | "skill"
  | "builtinSkill"
  | "recipe"
  | "subrecipe"
  | "agent"
  | "project";

export type SourceScope =
  | { scope: "global" }
  | { scope: "projectDir"; projectDir: string }
  | { scope: "projectId"; projectId: string };

export interface SourceEntry {
  type: SourceType;
  name: string;
  description: string;
  content: string;
  /** Stable on-disk path; pass it back to update/delete/export. */
  path: string;
  global: boolean;
  writable?: boolean;
  supportingFiles?: string[];
  properties?: Record<string, unknown>;
}

export interface ListSourcesRequest {
  type?: SourceType | null;
  projectDir?: string | null;
  includeProjectSources?: boolean;
}

export interface CreateSourceRequest {
  type: SourceType;
  name: string;
  description: string;
  content: string;
  target: SourceScope;
  properties?: Record<string, unknown>;
}

export interface UpdateSourceRequest {
  type: SourceType;
  path: string;
  name: string;
  description: string;
  content: string;
  properties?: Record<string, unknown> | null;
}

/** MCP server configuration as edited in Settings → Extensions, stored verbatim. */
export type McpExtension = {
  type: string;
  name: string;
  description?: string;
  [key: string]: unknown;
};

export interface McpExtensionEntry {
  extension: McpExtension;
  enabled: boolean;
  configKey?: string | null;
}

export interface PreferenceValue {
  key: string;
  value?: unknown;
}

export interface SessionTranscriptMessage {
  id: string;
  role: "user" | "assistant";
  created?: string | null;
  content: { type: "text"; text: string }[];
}

export interface SessionTranscript {
  messages: SessionTranscriptMessage[];
}

/** What rewriting a stored message's text did on the host. */
export interface SessionMessageUpdateResponse {
  /** Stored chunks that carried the text being edited before the rewrite. */
  chunks: number;
  /** Whether the message is the last one with text, so the list snippet now quotes the edit. */
  lastMessage: boolean;
}

/** What taking a step out of a stored message did on the host. */
export interface SessionMessageRemoveResponse {
  /** Stored updates removed. */
  removed: number;
  /** Whether the step held the chat's last text, so the list snippet moved. */
  lastMessage: boolean;
  /** The snippet the chat list quotes now, when it moved; null when no text is left. */
  snippet: string | null;
}

/**
 * One reasoning-effort value a harness offers for a model, in that harness's
 * own vocabulary ("xhigh", "ultra", "default"). Never an app-wide enum.
 */
export interface ProviderInventoryModelEffort {
  value: string;
  name?: string;
  description?: string | null;
}

export interface ProviderInventoryModel {
  id: string;
  name: string;
  description?: string | null;
  family?: string | null;
  contextLimit?: number | null;
  reasoning?: boolean | null;
  recommended?: boolean;
  /**
   * Which page of the picker the row belongs on. Presentation only: a model
   * its harness advertises is listed whichever group it lands in.
   */
  group?: "main" | "more";
  /** Menu position within the harness; lower comes first. */
  order?: number;
  /** The model this row is another name for ("default" → "opus[1m]"). */
  aliasOf?: string | null;
  /**
   * Effort values this model offers. Read it together with
   * `capabilitySource`: an empty list from a "probed" or "declared" row means
   * the model has NO effort control, while an empty list under "unknown"
   * means nobody has asked yet. The two must never read the same.
   */
  efforts?: ProviderInventoryModelEffort[];
  /** The effort the harness itself calls this model's default, if it says. */
  defaultEffort?: string | null;
  /** `null` is "unknown", never "no". */
  supportsFast?: boolean | null;
  /** The harness runs this model only in a session opened on it. */
  opensOnModel?: boolean;
  /** Where `efforts`/`supportsFast` came from. Absent on older hosts. */
  capabilitySource?: "probed" | "declared" | "unknown";
}

/**
 * What `providers/supported_models/list` answers.
 *
 * `schemaVersion` names the shape of the rows and `revision` the host
 * inventory generation that produced them -- a build id plus the moment the
 * harness was last probed. Together they let a renderer-side cache tell a
 * rebuilt list from an unchanged one instead of waiting out a clock. Both are
 * absent from hosts that predate the stamp.
 */
export interface ProviderSupportedModelsResponse {
  providerId: string;
  models: ProviderInventoryModel[];
  schemaVersion?: number;
  revision?: string;
}

export interface ProviderInventoryEntry {
  providerId: string;
  providerName: string;
  description: string;
  defaultModel: string;
  configured: boolean;
  available: boolean;
  providerType: string;
  category: "agent";
  acp?: boolean;
  visibleInSetup: boolean;
  deprecated: boolean;
  replacement?: string | null;
  configKeys: string[];
  setupSteps: string[];
  supportsRefresh: boolean;
  refreshing: boolean;
  models: ProviderInventoryModel[];
  lastUpdatedAt?: string | null;
  lastRefreshAttemptAt?: string | null;
  lastRefreshError?: string | null;
  stale: boolean;
  modelSelectionHint?: string | null;
}

export interface SteerSessionResponse {
  runId: string;
  messageId: string;
  /** The steered turn's reply; hosts before it was introduced omit it. */
  assistantMessageId?: string;
}

export interface HostSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
  _meta?: Record<string, unknown> | null;
}
