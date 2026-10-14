import { invoke } from "@tauri-apps/api/core";

export interface McpCheckResult {
  status: "connected" | "needsAuth" | "error";
  checkedAt: string;
  configurationRevision: string;
  message: string | null;
  serverName: string | null;
  serverVersion: string | null;
  tools: { name: string; description: string }[];
}

export interface LocalMcpConfiguration {
  configuration: Record<string, unknown>;
  revision: string;
  source: string;
}

export const MANAGED_MCP_QUERY_KEY = ["managed-mcps"] as const;
export const MCP_DIAGNOSTICS_QUERY_KEY = ["mcp-diagnostics"] as const;

export function listMcpDiagnostics(): Promise<Record<string, McpCheckResult>> {
  return invoke("list_mcp_diagnostics");
}

export function readLocalMcpConfiguration(
  id: string,
  workspacePaths: string[],
): Promise<LocalMcpConfiguration> {
  return invoke("read_local_mcp_configuration", { id, workspacePaths });
}

export function updateLocalMcpConfiguration(
  id: string,
  revision: string,
  workspacePaths: string[],
  action: {
    configuration?: Record<string, unknown>;
    enabled?: boolean;
    remove?: boolean;
    confirmed?: boolean;
  },
): Promise<void> {
  return invoke("update_local_mcp_configuration", {
    id,
    revision,
    workspacePaths,
    ...action,
  });
}

export function checkMcpConnection(
  id: string,
  workspacePaths: string[],
  configuration?: Record<string, unknown>,
): Promise<McpCheckResult> {
  return invoke("check_mcp_connection", { id, workspacePaths, configuration });
}
