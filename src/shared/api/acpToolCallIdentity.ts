import type { SessionUpdate } from "@agentclientprotocol/sdk";

export interface ToolCallIdentity {
  toolName?: string;
  extensionName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getToolCallIdentity(update: SessionUpdate): ToolCallIdentity {
  if (!isRecord(update._meta)) {
    return {};
  }

  // Claude Code's ACP adapter stamps the underlying tool name (e.g. "Task"
  // for subagent spawns) under `_meta.claudeCode.toolName`.
  const claudeCode = update._meta.claudeCode;
  if (isRecord(claudeCode) && typeof claudeCode.toolName === "string") {
    return { toolName: claudeCode.toolName };
  }

  // Codex's ACP adapter reports collaboration tools (e.g. "spawn_agent")
  // under `_meta.codex.collaboration.tool`.
  const codex = update._meta.codex;
  if (isRecord(codex)) {
    const collaboration = codex.collaboration;
    if (isRecord(collaboration) && typeof collaboration.tool === "string") {
      return { toolName: collaboration.tool };
    }
  }

  return {};
}
