import type {
  McpConfiguredServer,
  McpHarnessId,
} from "../api/localMcpInventory";
import type { McpCheckResult } from "../api/mcpManager";
import type { ExtensionEntry } from "../types";
import { groupMcpServers, HARNESS_LABELS } from "./localMcpInventory";
import type { McpInventory } from "../api/localMcpInventory";

export interface McpItem {
  id: string;
  name: string;
  description: string;
  transport: string;
  endpoint?: string;
  sources: McpConfiguredServer[];
  managed?: ExtensionEntry;
}

export function mcpItems(
  inventory: McpInventory | undefined,
  managed: ExtensionEntry[],
): McpItem[] {
  return [
    ...managed.map((entry) => ({
      id: `flock:${entry.config_key}`,
      name: entry.name,
      description: entry.description,
      transport: entry.type === "streamable_http" ? "http" : entry.type,
      endpoint:
        "uri" in entry && entry.uri ? safeEndpoint(entry.uri) : undefined,
      sources: [],
      managed: entry,
    })),
    ...groupMcpServers(inventory).map((group) => ({
      id: group.id,
      name: group.displayName,
      description:
        group.entries.find((entry) => entry.description)?.description ?? "",
      transport: group.entries[0].transport,
      endpoint: group.entries[0].endpoint ?? undefined,
      sources: group.entries,
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

export function itemHarnesses(item: McpItem): string {
  return item.managed
    ? "Flock"
    : [
        ...new Set(
          item.sources.map((source) => HARNESS_LABELS[source.harness]),
        ),
      ].join(", ");
}

function safeEndpoint(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

export function itemEnabled(item: McpItem): boolean {
  return (
    item.managed?.enabled ??
    item.sources.some((source) => source.enabled !== false)
  );
}

export function latestItemDiagnostic(
  item: McpItem,
  diagnostics: Record<string, McpCheckResult>,
): McpCheckResult | undefined {
  const ids = item.managed
    ? [item.id]
    : item.sources
        .filter((source) => source.enabled !== false)
        .map((source) => source.id);
  return ids
    .map((id) => {
      const result = diagnostics[id];
      const source = item.sources.find((source) => source.id === id);
      return result &&
        (!(
          source?.configurationRevision ?? item.managed?.configurationRevision
        ) ||
          (source?.configurationRevision ??
            item.managed?.configurationRevision) ===
            result.configurationRevision)
        ? result
        : undefined;
    })
    .filter((value): value is McpCheckResult => Boolean(value))
    .sort((a, b) => {
      // An error in one provider must remain visible after another connects.
      const aIssue = a.status !== "connected";
      const bIssue = b.status !== "connected";
      return (
        Number(bIssue) - Number(aIssue) ||
        b.checkedAt.localeCompare(a.checkedAt)
      );
    })[0];
}

export function searchMcpItems(items: McpItem[], query: string): McpItem[] {
  const term = query.trim().toLowerCase();
  return items.filter(
    (item) =>
      !term ||
      [
        item.name,
        item.description,
        itemHarnesses(item),
        item.endpoint,
        ...item.sources.map((source) => source.source.label),
      ]
        .join(" ")
        .toLowerCase()
        .includes(term),
  );
}

export function normalizeMcpConfiguration(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const command = raw.command ?? raw.cmd;
  return {
    name: raw.name ?? "",
    description: raw.description ?? "",
    transport: command ? "stdio" : "http",
    command: Array.isArray(command) ? command[0] : (command ?? ""),
    args: Array.isArray(command) ? command.slice(1) : (raw.args ?? []),
    url: raw.url ?? raw.uri ?? raw.httpUrl ?? "",
    env: raw.env ?? raw.envs ?? raw.environment ?? {},
    headers: raw.headers ?? raw.http_headers ?? {},
  };
}

export interface McpDraft {
  name: string;
  description: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  url: string;
  env: Record<string, string>;
  headers: Record<string, string>;
}

export function configurationFromDraft(
  draft: McpDraft,
  original: Record<string, unknown>,
  harness?: McpHarnessId,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...original,
    description: draft.description,
  };
  for (const key of [
    "cmd",
    "command",
    "args",
    "uri",
    "url",
    "env",
    "envs",
    "environment",
    "headers",
    "http_headers",
    "httpUrl",
  ])
    delete result[key];
  if (!harness) {
    Object.assign(result, {
      name: draft.name,
      type: draft.transport === "http" ? "streamable_http" : "stdio",
    });
    if (draft.transport === "stdio")
      Object.assign(result, {
        cmd: draft.command,
        args: draft.args,
        envs: draft.env,
      });
    else Object.assign(result, { uri: draft.url, headers: draft.headers });
  } else if (harness === "openCode") {
    Object.assign(
      result,
      draft.transport === "stdio"
        ? {
            type: "local",
            command: [draft.command, ...draft.args],
            environment: draft.env,
          }
        : { type: "remote", url: draft.url, headers: draft.headers },
    );
  } else {
    if (harness === "claudeCode") result.type = draft.transport;
    if (draft.transport === "stdio")
      Object.assign(result, {
        command: draft.command,
        args: draft.args,
        env: draft.env,
      });
    else
      Object.assign(result, {
        [harness === "gemini" ? "httpUrl" : "url"]: draft.url,
        [harness === "codex" ? "http_headers" : "headers"]: draft.headers,
      });
  }
  return result;
}

export function parseStringMap(raw: string): Record<string, string> {
  const parsed: unknown = JSON.parse(raw || "{}");
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((value) => typeof value === "string")
  )
    throw new Error("invalidMap");
  return parsed as Record<string, string>;
}

export function parseArguments(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw || "[]");
  if (
    !Array.isArray(parsed) ||
    !parsed.every((value) => typeof value === "string")
  )
    throw new Error("invalidArgs");
  return parsed;
}
