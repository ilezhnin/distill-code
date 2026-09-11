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

export interface ProviderInventoryModel {
  id: string;
  name: string;
  family?: string | null;
  contextLimit?: number | null;
  reasoning?: boolean | null;
  recommended?: boolean;
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
}

export interface HostSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
  _meta?: Record<string, unknown> | null;
}
