import {
  ClientSideConnection,
  type Agent,
  type Client,
  type Stream,
} from "@agentclientprotocol/sdk";

import type { MessagePart } from "@/shared/types/messageParts";
import type {
  CreateSourceRequest,
  HostSessionInfo,
  ListSourcesRequest,
  McpExtension,
  McpExtensionEntry,
  PreferenceValue,
  ProviderInventoryEntry,
  ProviderSupportedModelsResponse,
  SessionMessageRemoveResponse,
  SessionMessageUpdateResponse,
  SessionTranscript,
  SourceEntry,
  SourceScope,
  SourceType,
  SteerSessionResponse,
  UpdateSourceRequest,
} from "./hostTypes";

const EXT_PREFIX = "_distill/";

type Params = object;

/**
 * Typed access to the agent host's extension methods. Every call goes
 * through the same JSON-RPC connection as core ACP.
 */
export class HostExt {
  constructor(private readonly conn: ClientSideConnection) {}

  private call<T>(method: string, params: Params = {}): Promise<T> {
    return this.conn.extMethod(
      `${EXT_PREFIX}${method}`,
      params as Record<string, unknown>,
    ) as Promise<T>;
  }

  // Sessions
  sessionInfo(params: { sessionId: string }) {
    return this.call<{ session: HostSessionInfo }>("session/info", params);
  }
  sessionRename(params: { sessionId: string; title: string }) {
    return this.call<Params>("session/rename", params);
  }
  sessionArchive(params: { sessionId: string }) {
    return this.call<Params>("session/archive", params);
  }
  sessionUnarchive(params: { sessionId: string }) {
    return this.call<Params>("session/unarchive", params);
  }
  sessionProjectUpdate(params: {
    sessionId: string;
    projectId?: string | null;
  }) {
    return this.call<Params>("session/project/update", params);
  }
  sessionWorkingDirUpdate(params: { sessionId: string; workingDir: string }) {
    return this.call<Params>("session/working_dir/update", params);
  }
  sessionSteer(params: Params) {
    return this.call<SteerSessionResponse>("session/steer", params);
  }
  sessionExtensionsList(params: { sessionId: string }) {
    return this.call<{ extensions: McpExtension[] }>(
      "session/extensions/list",
      params,
    );
  }
  sessionExtensionsRemove(params: { sessionId: string; name: string }) {
    return this.call<Params>("session/extensions/remove", params);
  }
  sessionMessages(params: { sessionId: string }) {
    return this.call<SessionTranscript>("session/messages", params);
  }
  sessionMessageUpdate(params: {
    sessionId: string;
    messageId: string;
    role: "user" | "assistant";
    text: string;
    part?: MessagePart;
  }) {
    return this.call<SessionMessageUpdateResponse>(
      "session/message/update",
      params,
    );
  }
  sessionMessageRemove(params: {
    sessionId: string;
    messageId: string;
    role: "user" | "assistant";
    part: MessagePart;
  }) {
    return this.call<SessionMessageRemoveResponse>(
      "session/message/remove",
      params,
    );
  }

  // Preferences, settings
  preferencesRead(params: { keys?: string[] } = {}) {
    return this.call<{ values: PreferenceValue[] }>("preferences/read", params);
  }
  preferencesSave(params: { values?: PreferenceValue[] }) {
    return this.call<Params>("preferences/save", params);
  }
  preferencesRemove(params: { keys?: string[] }) {
    return this.call<Params>("preferences/remove", params);
  }
  settingsRead(params: { key: string }) {
    return this.call<{ value: unknown }>("settings/read", params);
  }
  settingsSave(params: { key: string; value: unknown }) {
    return this.call<Params>("settings/save", params);
  }

  // MCP servers
  configExtensionsList(params: Params = {}) {
    return this.call<{ extensions: McpExtensionEntry[]; warnings?: string[] }>(
      "config/extensions/list",
      params,
    );
  }
  configExtensionsAdd(params: { extension: McpExtension; enabled?: boolean }) {
    return this.call<Params>("config/extensions/add", params);
  }
  configExtensionsRemove(params: { configKey: string }) {
    return this.call<Params>("config/extensions/remove", params);
  }
  configExtensionsSetEnabled(params: { configKey: string; enabled: boolean }) {
    return this.call<Params>("config/extensions/set_enabled", params);
  }

  // Harness inventory
  providersList(params: Params = {}) {
    return this.call<{ providers: ProviderInventoryEntry[] }>(
      "providers/list",
      params,
    );
  }
  providersSupportedModelsList(params: { providerId: string }) {
    return this.call<ProviderSupportedModelsResponse>(
      "providers/supported_models/list",
      params,
    );
  }
  providersInventoryRefresh(params: { providerId: string }) {
    return this.call<{ providerId: string; models: unknown[] }>(
      "providers/inventory/refresh",
      params,
    );
  }

  // Sources (skills, agents, projects)
  sourcesList(params: ListSourcesRequest = {}) {
    return this.call<{ sources: SourceEntry[] }>("sources/list", params);
  }
  sourcesCreate(params: CreateSourceRequest) {
    return this.call<{ source: SourceEntry }>("sources/create", params);
  }
  sourcesUpdate(params: UpdateSourceRequest) {
    return this.call<{ source: SourceEntry }>("sources/update", params);
  }
  sourcesDelete(params: { type: SourceType; path: string }) {
    return this.call<Params>("sources/delete", params);
  }
  sourcesExport(params: { type: SourceType; path: string }) {
    return this.call<{ json: string; filename: string }>(
      "sources/export",
      params,
    );
  }
  sourcesImport(params: { data: string; target: SourceScope }) {
    return this.call<{ sources: SourceEntry[] }>("sources/import", params);
  }
}

/**
 * The renderer's ACP client: a plain `ClientSideConnection` plus the host
 * extension namespace.
 */
export class HostClient extends ClientSideConnection {
  readonly host: HostExt;

  constructor(toClient: (agent: Agent) => Client, stream: Stream) {
    super(toClient, stream);
    this.host = new HostExt(this);
  }
}
