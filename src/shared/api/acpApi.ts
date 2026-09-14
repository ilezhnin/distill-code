import type {
  ContentBlock,
  ForkSessionRequest,
  NewSessionResponse,
  LoadSessionResponse,
  ListSessionsRequest,
  PromptResponse,
  SessionInfo,
} from "@agentclientprotocol/sdk";
import { messageSnippet } from "@/features/chat/lib/messageSnippet";
import { getCuratedAgentProviders } from "@/features/providers/curatedProviders";
import { getClient, trackPendingPrompt } from "./acpConnection";
import {
  applySessionConfigOptionsSnapshot,
  readSessionConfigOptionsSnapshots,
  type AcpSessionConfigSnapshotContext,
  type AcpSessionConfigSnapshots,
} from "./acpSessionConfigSnapshots";
import type { SessionTranscript } from "./hostTypes";
import { perfLog } from "@/shared/lib/perfLog";
import {
  logReasoningEffortInfo,
  reasoningEffortConfigLogFields,
  shortLogId,
} from "@/shared/lib/reasoningEffortDiagnostics";
import { isRecord } from "@/shared/lib/isRecord";

export interface AcpProvider {
  id: string;
  label: string;
}

export interface AcpSessionInfo {
  sessionId: string;
  title: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  lastMessageAt: string | null;
  archivedAt: string | null;
  userSetName: boolean;
  messageCount: number;
  subtitle: string | null;
  workingDir: string | null;
  projectId?: string | null;
  providerId: string | null;
  modelId: string | null;
  /**
   * The reasoning effort the host last saw the bridge acknowledge for this
   * chat's model, in the harness's own vocabulary. Null when nobody chose one
   * and the model runs at its own default. Optional because a host older than
   * the run-settings split never sends it.
   */
  reasoningEffort?: string | null;
  /** Acknowledged fast mode, with the same null and absence rules as effort. */
  fastMode?: boolean | null;
  personaId: string | null;
  activeRunId?: string | null;
}

export interface AcpSessionsPage {
  sessions: AcpSessionInfo[];
  nextCursor: string | null;
}

export async function listProviders(): Promise<AcpProvider[]> {
  return getCuratedAgentProviders();
}

function mapLastMessageSnippet(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return messageSnippet(value);
}

function metaString(
  meta: SessionInfo["_meta"] | null | undefined,
  key: string,
): string | null {
  const value = meta?.[key];
  return typeof value === "string" ? value : null;
}

function metaNumber(
  meta: SessionInfo["_meta"] | null | undefined,
  key: string,
): number | null {
  const value = meta?.[key];
  return typeof value === "number" ? value : null;
}

function metaBoolean(
  meta: SessionInfo["_meta"] | null | undefined,
  key: string,
): boolean | null {
  const value = meta?.[key];
  return typeof value === "boolean" ? value : null;
}

function mapSessionInfo(info: SessionInfo): AcpSessionInfo {
  const meta = info._meta;
  const activeRunValue =
    meta && "activeRunId" in meta ? meta.activeRunId : undefined;
  const activeRunId =
    typeof activeRunValue === "string" || activeRunValue === null
      ? activeRunValue
      : undefined;

  return {
    sessionId: info.sessionId,
    title: info.title ?? null,
    updatedAt: info.updatedAt ?? null,
    createdAt: metaString(meta, "createdAt"),
    lastMessageAt: metaString(meta, "lastMessageAt"),
    archivedAt: metaString(meta, "archivedAt"),
    userSetName: meta?.userSetName === true,
    messageCount: metaNumber(meta, "messageCount") ?? 0,
    subtitle: mapLastMessageSnippet(meta?.lastMessageSnippet),
    workingDir: info.cwd ?? null,
    projectId: metaString(meta, "projectId"),
    providerId: metaString(meta, "providerId"),
    modelId: metaString(meta, "modelId"),
    ...(meta && "reasoningEffort" in meta
      ? { reasoningEffort: metaString(meta, "reasoningEffort") }
      : {}),
    ...(meta && "fastMode" in meta
      ? { fastMode: metaBoolean(meta, "fastMode") }
      : {}),
    personaId: metaString(meta, "personaId"),
    ...(activeRunId !== undefined ? { activeRunId } : {}),
  };
}

export async function getSessionInfo(
  sessionId: string,
): Promise<AcpSessionInfo> {
  const client = await getClient();
  const result = await client.host.sessionInfo({ sessionId });
  return mapSessionInfo(result.session as unknown as SessionInfo);
}

export async function listSessionsPage({
  cursor,
}: {
  cursor?: string | null;
} = {}): Promise<AcpSessionsPage> {
  const client = await getClient();
  const normalizedCursor = cursor?.trim() || null;
  // ACP session/list only standardizes cwd and cursor filters. Project
  // membership lives in _meta.projectId, so callers paginate globally and
  // group by projectId client-side instead of using cwd as a proxy.
  const params: ListSessionsRequest = {};
  if (normalizedCursor != null) {
    params.cursor = normalizedCursor;
  }

  const response = await client.listSessions(params);
  return {
    sessions: response.sessions.map(mapSessionInfo),
    nextCursor: response.nextCursor?.trim() || null,
  };
}

/** The text messages of a session as the host stored them. */
export async function readSessionTranscript(
  sessionId: string,
): Promise<SessionTranscript> {
  const client = await getClient();
  return client.host.sessionMessages({ sessionId });
}

export interface AcpForkSessionOptions {
  conversationBefore?: number;
}

function isValidConversationBefore(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export async function forkSession(
  sessionId: string,
  workingDir: string,
  options: AcpForkSessionOptions = {},
): Promise<AcpSessionInfo> {
  const client = await getClient();
  const params: ForkSessionRequest = {
    sessionId,
    cwd: workingDir,
    mcpServers: [],
  };
  if (isValidConversationBefore(options.conversationBefore)) {
    params._meta = { conversationBefore: options.conversationBefore };
  }

  const response = await client.unstable_forkSession(params);
  return {
    sessionId: response.sessionId,
    title: null,
    updatedAt: null,
    createdAt: metaString(response._meta, "createdAt"),
    lastMessageAt: metaString(response._meta, "lastMessageAt"),
    archivedAt: metaString(response._meta, "archivedAt"),
    userSetName: response._meta?.userSetName === true,
    messageCount: metaNumber(response._meta, "messageCount") ?? 0,
    subtitle: mapLastMessageSnippet(response._meta?.lastMessageSnippet),
    workingDir,
    projectId: metaString(response._meta, "projectId"),
    providerId: metaString(response._meta, "providerId"),
    modelId: metaString(response._meta, "modelId"),
    // The host opens a fork on the source's stored selection and answers with
    // what the bridge acknowledged for it; an older host says nothing.
    ...(response._meta && "reasoningEffort" in response._meta
      ? { reasoningEffort: metaString(response._meta, "reasoningEffort") }
      : {}),
    ...(response._meta && "fastMode" in response._meta
      ? { fastMode: metaBoolean(response._meta, "fastMode") }
      : {}),
    personaId: null,
  };
}

export async function setModel(
  sessionId: string,
  modelId: string,
  context: { providerId?: string; requestId?: string } = {},
): Promise<AcpSessionConfigSnapshots> {
  const sid = sessionId.slice(0, 8);
  const tClient = performance.now();
  const client = await getClient();
  const tCall = performance.now();
  const response = await client.setSessionConfigOption({
    sessionId,
    configId: "model",
    value: modelId,
  });
  const snapshots = readSessionConfigOptionsSnapshots(response);
  logReasoningEffortInfo("setModel response", {
    sessionId: shortLogId(sessionId),
    modelId,
    hasReasoningEffortSnapshot: Boolean(snapshots.reasoningEffort),
    ...reasoningEffortConfigLogFields(
      "reasoningEffort",
      snapshots.reasoningEffort,
    ),
  });
  applySessionConfigOptionsSnapshot(sessionId, response, {
    origin: "response",
    ...context,
    modelId: snapshots.model?.modelId ?? modelId,
  });
  perfLog(
    `[perf:api] ${sid} setModel(${modelId}) getClient=${(tCall - tClient).toFixed(1)}ms wire=${(performance.now() - tCall).toFixed(1)}ms`,
  );
  return snapshots;
}

export async function setSessionConfigOption(
  sessionId: string,
  configId: string,
  value: string | boolean,
  context: Omit<AcpSessionConfigSnapshotContext, "origin"> = {},
): Promise<AcpSessionConfigSnapshots> {
  const sid = sessionId.slice(0, 8);
  const tClient = performance.now();
  const client = await getClient();
  const tCall = performance.now();
  // Boolean config options (kind "boolean") take a typed boolean payload on
  // the wire; everything else is a select value id.
  const response = await client.setSessionConfigOption(
    typeof value === "boolean"
      ? { sessionId, configId, type: "boolean", value }
      : { sessionId, configId, value },
  );
  const snapshots = readSessionConfigOptionsSnapshots(response);
  logReasoningEffortInfo("setSessionConfigOption response", {
    sessionId: shortLogId(sessionId),
    configId,
    requestedValue: value,
    hasReasoningEffortSnapshot: Boolean(snapshots.reasoningEffort),
    ...reasoningEffortConfigLogFields(
      "reasoningEffort",
      snapshots.reasoningEffort,
    ),
  });
  applySessionConfigOptionsSnapshot(sessionId, response, {
    origin: "response",
    ...context,
  });
  perfLog(
    `[perf:api] ${sid} setSessionConfigOption(${configId}=${value}) getClient=${(tCall - tClient).toFixed(1)}ms wire=${(performance.now() - tCall).toFixed(1)}ms`,
  );
  return snapshots;
}

/** Move a session onto another harness; the host starts a fresh bridge session. */
export async function setProvider(
  sessionId: string,
  providerId: string,
  context: { requestId?: string } = {},
): Promise<AcpSessionConfigSnapshots> {
  const sid = sessionId.slice(0, 8);
  const tClient = performance.now();
  const client = await getClient();
  const tCall = performance.now();
  const response = await client.setSessionConfigOption({
    sessionId,
    configId: "provider",
    value: providerId,
  });
  const snapshots = readSessionConfigOptionsSnapshots(response);
  logReasoningEffortInfo("setProvider response", {
    sessionId: shortLogId(sessionId),
    providerId,
    hasReasoningEffortSnapshot: Boolean(snapshots.reasoningEffort),
    ...reasoningEffortConfigLogFields(
      "reasoningEffort",
      snapshots.reasoningEffort,
    ),
  });
  applySessionConfigOptionsSnapshot(sessionId, response, {
    origin: "response",
    ...context,
    providerId,
    modelId: snapshots.model?.modelId,
  });
  perfLog(
    `[perf:api] ${sid} setProvider(${providerId}) getClient=${(tCall - tClient).toFixed(1)}ms wire=${(performance.now() - tCall).toFixed(1)}ms`,
  );
  return snapshots;
}

export async function updateWorkingDir(
  sessionId: string,
  workingDir: string,
  beforeUpdate?: () => void,
): Promise<void> {
  const client = await getClient();
  // Run guards after the asynchronous client lookup and synchronously before
  // dispatching the mutation. This lets callers close local state races
  // without exposing the ACP client or duplicating the wire operation.
  beforeUpdate?.();
  await client.host.sessionWorkingDirUpdate({ sessionId, workingDir });
}

export async function updateSessionProject(
  sessionId: string,
  projectId: string | null,
): Promise<void> {
  const client = await getClient();
  await client.host.sessionProjectUpdate({ sessionId, projectId });
}

export async function archiveSession(sessionId: string): Promise<void> {
  const client = await getClient();
  await client.host.sessionArchive({ sessionId });
}

export async function deleteSession(sessionId: string): Promise<void> {
  const client = await getClient();
  await client.extMethod("session/delete", { sessionId });
}

export async function unarchiveSession(sessionId: string): Promise<void> {
  const client = await getClient();
  await client.host.sessionUnarchive({ sessionId });
}

export async function renameSession(
  sessionId: string,
  title: string,
): Promise<void> {
  const client = await getClient();
  await client.host.sessionRename({ sessionId, title });
}

export async function cancelSession(sessionId: string): Promise<void> {
  const client = await getClient();
  await client.cancel({ sessionId });
}

export interface NewSessionOptions {
  providerId?: string;
  projectId?: string;
  personaId?: string;
  hidden?: boolean;
  /**
   * The model, effort and fast mode the chat should open on. The host applies
   * them inside `session/new` in the order mode → model → effort → fast, so the
   * first turn already runs on them instead of on the harness default.
   */
  modelId?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
}

export async function newSession(
  workingDir: string,
  options: NewSessionOptions = {},
): Promise<NewSessionResponse> {
  const {
    providerId,
    projectId,
    personaId,
    hidden,
    modelId,
    reasoningEffort,
    fastMode,
  } = options;
  const tClient = performance.now();
  const client = await getClient();
  const request: Parameters<typeof client.newSession>[0] = {
    cwd: workingDir,
    mcpServers: [],
  };

  const meta: Record<string, string | boolean> = {};
  if (providerId) meta.provider = providerId;
  if (projectId) meta.projectId = projectId;
  if (personaId) meta.personaId = personaId;
  if (hidden) meta.hidden = true;
  if (modelId) meta.model = modelId;
  if (reasoningEffort) meta.reasoningEffort = reasoningEffort;
  if (fastMode !== undefined) meta.fastMode = fastMode;
  if (Object.keys(meta).length > 0) request._meta = meta;

  const tCall = performance.now();
  const response = await client.newSession(request);
  const sid = response.sessionId.slice(0, 8);
  perfLog(
    `[perf:api] ${sid} newSession getClient=${(tCall - tClient).toFixed(1)}ms wire=${(performance.now() - tCall).toFixed(1)}ms`,
  );
  return response;
}

export async function loadSession(
  sessionId: string,
  workingDir: string,
): Promise<LoadSessionResponse> {
  const sid = sessionId.slice(0, 8);
  const tClient = performance.now();
  const client = await getClient();
  const tCall = performance.now();
  const response = await client.loadSession({
    sessionId,
    cwd: workingDir,
    mcpServers: [],
  });
  const snapshots = readSessionConfigOptionsSnapshots(response);
  logReasoningEffortInfo("loadSession response", {
    sessionId: shortLogId(sessionId),
    hasReasoningEffortSnapshot: Boolean(snapshots.reasoningEffort),
    ...reasoningEffortConfigLogFields(
      "reasoningEffort",
      snapshots.reasoningEffort,
    ),
  });
  perfLog(
    `[perf:api] ${sid} loadSession getClient=${(tCall - tClient).toFixed(1)}ms wire=${(performance.now() - tCall).toFixed(1)}ms`,
  );
  return response;
}

export async function prompt(
  sessionId: string,
  content: ContentBlock[],
  meta?: Record<string, unknown>,
  callbacks: {
    onPromptDispatching?: () => void;
    onPromptDispatched?: () => void;
  } = {},
): Promise<PromptResponse> {
  const client = await getClient();
  callbacks.onPromptDispatching?.();
  const promptPromise = trackPendingPrompt(
    client.prompt({
      sessionId,
      prompt: content,
      _meta: meta,
    }),
  );
  callbacks.onPromptDispatched?.();
  return promptPromise;
}

const UNKNOWN_EXPECTED_RUN_ID = "__berd_unknown_active_run__";

function extractActualRunId(error: unknown): string | null {
  if (!isRecord(error) || !("data" in error)) {
    return null;
  }

  const data = error.data;
  if (isRecord(data) && typeof data.actualRunId === "string") {
    return data.actualRunId;
  }

  const message =
    typeof data === "string"
      ? data
      : isRecord(data) && typeof data.message === "string"
        ? data.message
        : "";
  const match = message.match(/found `([^`]+)`/);
  return match?.[1] ?? null;
}

export interface AcpSteerResponse {
  runId: string;
  messageId: string;
  /** The id the steered turn's reply streams under, when the host names it. */
  assistantMessageId?: string;
}

export async function steerSession(
  sessionId: string,
  content: ContentBlock[],
  expectedRunId: string | null,
  meta?: Record<string, unknown>,
): Promise<AcpSteerResponse> {
  const client = await getClient();
  const steer = async (runId: string): Promise<AcpSteerResponse> => {
    const response = await client.host.sessionSteer({
      sessionId,
      prompt: content,
      expectedRunId: runId,
      ...(meta ? { _meta: meta } : {}),
    });
    if (
      typeof response.runId !== "string" ||
      typeof response.messageId !== "string"
    ) {
      throw new Error("Steer response is missing runId or messageId");
    }
    return {
      runId: response.runId,
      messageId: response.messageId,
      ...(typeof response.assistantMessageId === "string" &&
      response.assistantMessageId.length > 0
        ? { assistantMessageId: response.assistantMessageId }
        : {}),
    };
  };

  try {
    return await steer(expectedRunId ?? UNKNOWN_EXPECTED_RUN_ID);
  } catch (error) {
    const actualRunId = extractActualRunId(error);
    if (actualRunId && actualRunId !== expectedRunId) {
      return steer(actualRunId);
    }
    throw error;
  }
}
