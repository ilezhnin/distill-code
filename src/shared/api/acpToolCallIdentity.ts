import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { isRecord } from "@/shared/lib/isRecord";

export interface ToolCallIdentity {
  toolName?: string;
  extensionName?: string;
}

export function getToolCallIdentity(update: SessionUpdate): ToolCallIdentity {
  if (
    "name" in update &&
    typeof update.name === "string" &&
    update.name.trim()
  ) {
    return { toolName: update.name };
  }
  if (!isRecord(update._meta)) {
    return {};
  }

  // Claude Code's ACP adapter stamps the underlying tool name (e.g. "Task"
  // for subagent spawns) under `_meta.claudeCode.toolName`.
  const claudeCode = update._meta.claudeCode;
  if (isRecord(claudeCode) && typeof claudeCode.toolName === "string") {
    return { toolName: claudeCode.toolName };
  }

  // Kimi Code's adapter names no tool. The host names the `Agent` call it
  // saw start a subagent, under `_meta.kimiCode.toolName`, from the CLI's own
  // session record.
  const kimiCode = update._meta.kimiCode;
  if (isRecord(kimiCode) && typeof kimiCode.toolName === "string") {
    return { toolName: kimiCode.toolName };
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
