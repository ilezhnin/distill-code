import {
  clearWorkspaceToolCallObservations,
  observeWorkspaceToolCall,
} from "./acpWorkspaceObservation";
import type {
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { i18n } from "@/shared/i18n";
import type { SessionCostBilling, TokenState } from "@/shared/types/chat";
import { createSystemNotificationMessage } from "@/shared/types/messages";
import {
  readUsageCostBilledFlag,
  sessionCostBillingForAmount,
} from "@/features/chat/lib/sessionCostBilling";
import {
  onChatSessionReleased,
  useChatStore,
} from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  bufferReplayTokenState,
  clearReplayBuffer,
  ensureReplayBuffer,
  getBufferedMessage,
  getReplayBuffer,
} from "@/features/chat/hooks/replayBuffer";
import type {
  Message,
  ImageContent,
  MessageContent,
  MessageMetadata,
  ToolCallLocation,
  ToolKind,
  ToolRequestContent,
  ToolResponseContent,
} from "@/shared/types/messages";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import {
  clearActiveMessageId,
  clearActiveMessageTracking,
  getActiveMessagePreset,
  recordLiveAgentMessageChunk,
} from "@/shared/api/acpActiveMessageTracking";
import type {
  AcpNotificationHandler,
  AcpPermissionAnswerReport,
} from "@/shared/api/acpConnection";
import {
  clearSkillReplayChips,
  handleReplayUserMessageChunk,
} from "./acpSkillReplayChips";
import {
  extractToolStructuredContent,
  extractToolResultText,
  extractToolResultImages,
  findReplayMessageWithToolCall,
  hydrateToolResultImages,
} from "./acpToolCallContent";
import {
  clearReplayAssistantTracking,
  completeReplayAssistantMessage,
  ensureReplayAssistantMessage,
  getTrackedReplayAssistantMessageId,
} from "./acpReplayAssistant";
import {
  getHostAssistantMessageId,
  getReplayAssistantMessageId,
  getReplayAssistantMetadata,
  getReplayCreated,
  getReplayMessageId,
  getReplayUserMetadata,
} from "@/shared/api/acpReplayMetadata";
import { handleSessionInfoUpdate } from "./acpSessionInfoUpdate";
import { getToolCallIdentity } from "@/shared/api/acpToolCallIdentity";
import {
  getSubagentToolCallContext,
  resolveSubagentContext,
} from "@/features/chat/lib/subagentToolCalls";
import { applyChatSessionConfigOptionsSnapshot } from "./sessionConfigSnapshotAdapter";
import { logSessionId, perfLog } from "@/shared/lib/perfLog";
import {
  enqueueStreamingTextUpdate,
  enqueueStreamingThinkingUpdate,
  enqueueStreamingTerminalUpdate,
  flushBufferedStreamingUpdatesForSession,
  clearStreamingMessageOwners,
  isStreamingMessageOwnedByCurrentPrompt,
  registerStreamingMessageOwner,
  releaseStreamingSession,
} from "./liveStreamingUpdates";
import { addSessionWorkedMs } from "@/features/stats/lib/usageLedger";
import { recordAcpSessionUsage } from "@/features/stats/lib/usageRecorder";
import { isRecord } from "@/shared/lib/isRecord";
import { completeAssistantMessage } from "@/features/chat/lib/messageCompletion";
import {
  observeExecutionOwner,
  isBenchmarkSession,
} from "@/features/chat/lib/executionOwnership";
import { handleSessionEvent } from "./acpSessionEvents";
import {
  appendTerminalOutput,
  getTerminalOutputData,
  hasTerminalOutput,
} from "./acpTerminalOutput";

// Per-session perf counters for replay streaming.
interface ReplayPerf {
  firstAt: number;
  lastAt: number;
  count: number;
}
const replayPerf = new Map<string, ReplayPerf>();
const loadingLiveUpdates = new Map<string, SessionNotification[]>();
const historyBoundaries = new Map<string, number>();

export function beginHistorySnapshot(sessionId: string): void {
  loadingLiveUpdates.set(sessionId, []);
}

export async function acceptHistorySnapshot(
  sessionId: string,
  page: import("@/shared/api/acpHistory").HistoryPage,
): Promise<boolean> {
  const live = loadingLiveUpdates.get(sessionId);
  if (!live) return false;
  clearReplayBuffer(sessionId);
  clearReplaySessionTracking(sessionId);
  clearReplayAssistantTracking(sessionId);
  clearSkillReplayChips(sessionId);
  ensureReplayBuffer(sessionId);
  const started = performance.now();
  for (const event of page.events) {
    if (loadingLiveUpdates.get(sessionId) !== live) return false;
    await handleReplay(sessionId, event.update);
  }
  // Notifications are published only after commit. Rows at or below the
  // snapshot's boundary have already been replayed, even if delivered later.
  for (let index = 0; index < live.length; index++) {
    if (loadingLiveUpdates.get(sessionId) !== live) return false;
    const update = live[index].update;
    const meta = update._meta?.distill;
    const id = isRecord(meta) ? meta.eventId : undefined;
    if (typeof id === "number" && id <= page.highWaterEventId) continue;
    await handleReplay(sessionId, update);
  }
  loadingLiveUpdates.delete(sessionId);
  historyBoundaries.set(sessionId, page.highWaterEventId);
  replayPerf.set(sessionId, {
    firstAt: started,
    lastAt: performance.now(),
    count: page.events.length,
  });
  return true;
}

export async function failHistorySnapshot(sessionId: string): Promise<void> {
  const live = loadingLiveUpdates.get(sessionId) ?? [];
  loadingLiveUpdates.delete(sessionId);
  for (const event of live) await handleLive(sessionId, event.update);
}

/** Older pages use an isolated replay buffer and never publish old session state. */
export async function parseHistoryPage(
  sessionId: string,
  events: SessionNotification[],
  cursor: number,
): Promise<Message[]> {
  const bufferId = `${sessionId}:history:${cursor}`;
  try {
    for (const event of events) {
      if (
        [
          "session_info_update",
          "config_option_update",
          "usage_update",
        ].includes(event.update.sessionUpdate)
      )
        continue;
      await handleReplay(bufferId, event.update, sessionId);
    }
    completeReplayAssistantMessage(bufferId);
    return getReplayBuffer(bufferId) ?? [];
  } finally {
    clearReplayBuffer(bufferId);
    clearReplaySessionTracking(bufferId);
    clearReplayAssistantTracking(bufferId);
    clearSkillReplayChips(bufferId);
  }
}
interface ReplayAgentBoundaryCandidate {
  messageId: string;
  precedingAssistantMessageId: string | null;
}
const pendingReplayAgentBoundaryCandidates = new Map<
  string,
  ReplayAgentBoundaryCandidate[]
>();
const replayAssistantMessageIds = new Map<string, string>();
const replayAgentBoundaryActive = new Set<string>();

/** The replay bookkeeping above, for one session. */
function clearReplaySessionTracking(sessionId: string): void {
  replayPerf.delete(sessionId);
  pendingReplayAgentBoundaryCandidates.delete(sessionId);
  replayAssistantMessageIds.delete(sessionId);
  replayAgentBoundaryActive.delete(sessionId);
}

/**
 * A replay ends when its loader clears the session's loading flag, whether the
 * history was committed to the transcript or discarded. The bookkeeping above
 * only means something while that replay runs: left behind, it kept an entry
 * per chat ever opened, and the next load of the same chat started from the
 * last one's boundary candidates and timings instead of a clean slate. The
 * loader reads the replay's timings before it clears the flag.
 */
useChatStore.subscribe(
  (state) => state.loadingSessionIds,
  (loadingSessionIds, previousLoadingSessionIds) => {
    for (const sessionId of previousLoadingSessionIds) {
      if (!loadingSessionIds.has(sessionId)) {
        clearReplaySessionTracking(sessionId);
      }
    }
  },
);

function enqueueReplayAgentBoundaryCandidate(
  sessionId: string,
  messageId: string,
): void {
  const candidates = pendingReplayAgentBoundaryCandidates.get(sessionId) ?? [];
  if (!candidates.some((candidate) => candidate.messageId === messageId)) {
    candidates.push({
      messageId,
      precedingAssistantMessageId:
        replayAssistantMessageIds.get(sessionId) ?? null,
    });
    pendingReplayAgentBoundaryCandidates.set(sessionId, candidates);
  }
  replayAgentBoundaryActive.delete(sessionId);
}

function removeReplayAgentBoundaryCandidate(
  sessionId: string,
  messageId: string,
): void {
  const candidates = pendingReplayAgentBoundaryCandidates.get(sessionId);
  if (!candidates?.some((candidate) => candidate.messageId === messageId)) {
    return;
  }
  const remainingCandidates = candidates.filter(
    (candidate) => candidate.messageId !== messageId,
  );
  if (remainingCandidates.length === 0) {
    pendingReplayAgentBoundaryCandidates.delete(sessionId);
  } else {
    pendingReplayAgentBoundaryCandidates.set(sessionId, remainingCandidates);
  }
}

function handleReplayAssistantBoundary(
  sessionId: string,
  update: SessionUpdate,
): void {
  const replayMessageId = getReplayAssistantMessageId(update);
  const assistantMessageId =
    replayMessageId ?? replayAssistantMessageIds.get(sessionId) ?? "anonymous";
  const previousAssistantMessageId =
    replayAssistantMessageIds.get(sessionId) ?? null;
  const isNewAssistantMessage =
    previousAssistantMessageId !== assistantMessageId;
  const isInterventionBoundary = isRunInterventionBoundary(update);

  if (!isInterventionBoundary) {
    replayAgentBoundaryActive.delete(sessionId);
    if (isNewAssistantMessage) {
      const candidates = pendingReplayAgentBoundaryCandidates.get(sessionId);
      const remainingCandidates = candidates?.filter(
        (candidate) =>
          candidate.precedingAssistantMessageId !== previousAssistantMessageId,
      );
      if (remainingCandidates?.length) {
        pendingReplayAgentBoundaryCandidates.set(
          sessionId,
          remainingCandidates,
        );
      } else {
        pendingReplayAgentBoundaryCandidates.delete(sessionId);
      }
    }
    replayAssistantMessageIds.set(sessionId, assistantMessageId);
    return;
  }

  replayAssistantMessageIds.set(sessionId, assistantMessageId);
  if (replayAgentBoundaryActive.has(sessionId)) return;
  replayAgentBoundaryActive.add(sessionId);

  const candidates = pendingReplayAgentBoundaryCandidates.get(sessionId);
  const deliveredCandidate = candidates?.shift();
  if (!candidates || candidates.length === 0) {
    pendingReplayAgentBoundaryCandidates.delete(sessionId);
  }
  if (!deliveredCandidate) return;

  const deliveredMessage = getReplayBuffer(sessionId)?.find(
    (message) => message.id === deliveredCandidate.messageId,
  );
  if (deliveredMessage) {
    deliveredMessage.metadata = {
      ...deliveredMessage.metadata,
      delivery: "steer",
    };
  }
}

/**
 * The host saves a steered prompt before echoing its first block live, so a
 * load that overlaps the echo sees that block twice: once from the log, once
 * as the live boundary. The seen blocks live with the replay buffer, so every
 * load starts with a clean slate.
 */
const replayedSteerBlocks = new WeakMap<object, Set<string>>();

function isRepeatedReplaySteerBlock(
  sessionId: string,
  messageId: string,
  content: unknown,
): boolean {
  const buffer = ensureReplayBuffer(sessionId);
  let seen = replayedSteerBlocks.get(buffer);
  if (!seen) {
    seen = new Set();
    replayedSteerBlocks.set(buffer, seen);
  }
  const key = `${messageId}\0${JSON.stringify(content)}`;
  if (seen.has(key)) {
    return true;
  }
  seen.add(key);
  return false;
}

function rawInputToArguments(rawInput: unknown): Record<string, unknown> {
  return isRecord(rawInput) ? rawInput : {};
}

function toolKindFromUpdate(update: SessionUpdate): ToolKind | undefined {
  const record: Record<string, unknown> = update;
  const value = record.kind;
  return typeof value === "string" ? (value as ToolKind) : undefined;
}

function locationsFromUpdate(
  update: SessionUpdate,
): ToolCallLocation[] | undefined {
  const record: Record<string, unknown> = update;
  const value = record.locations;
  if (!Array.isArray(value)) return undefined;

  return value
    .filter(
      (location): location is { path: string; line?: number | null } =>
        isRecord(location) && typeof location.path === "string",
    )
    .map((location) => ({
      path: location.path,
      ...(typeof location.line === "number" || location.line === null
        ? { line: location.line }
        : {}),
    }));
}

type ToolCallUpdatePatch = Pick<
  Partial<ToolRequestContent>,
  "toolKind" | "locations"
>;

function toolCallUpdatePatch(update: SessionUpdate): ToolCallUpdatePatch {
  const toolKind = toolKindFromUpdate(update);
  const locations = locationsFromUpdate(update);

  return {
    ...(toolKind ? { toolKind } : {}),
    ...(locations ? { locations } : {}),
  };
}

/**
 * The patch to apply onto a tool request that already exists.
 *
 * `other` is ACP's default kind — "no better category" — so an update that
 * carries it after the `tool_call` already named a specific kind is saying
 * less, not correcting itself, and the specific kind stays. The grok bridge
 * does exactly this: its `list_dir` arrives as `kind: "list"` (off-spec, but
 * clearly a read) and every following `tool_call_update` says `other`. Letting
 * the update win turned a directory listing into "the conductor changed
 * something itself" and picked the generic icon for a call the bridge had
 * classified.
 */
function toolCallUpdatePatchFor(
  update: SessionUpdate,
  existing: Pick<ToolRequestContent, "toolKind"> | undefined,
): ToolCallUpdatePatch {
  const patch = toolCallUpdatePatch(update);
  const keepsSpecificKind =
    patch.toolKind === "other" &&
    existing?.toolKind !== undefined &&
    existing.toolKind !== "other";
  if (!keepsSpecificKind) return patch;
  return patch.locations ? { locations: patch.locations } : {};
}

export async function handleSessionNotification(
  notification: SessionNotification,
): Promise<void> {
  observeExecutionOwner(
    notification.sessionId,
    notification._meta?.executionOwner ??
      notification.update._meta?.executionOwner,
  );
  const sessionId = notification.sessionId;
  const { update } = notification;
  const captured = loadingLiveUpdates.get(sessionId);
  if (captured) {
    recordUsageNotification(sessionId, update);
    observeWorkspaceToolCall(sessionId, update);
    captured.push(notification);
    return;
  }
  const isReplay = useChatStore.getState().loadingSessionIds.has(sessionId);
  const hostMeta = update._meta?.distill;
  if (
    isRecord(hostMeta) &&
    typeof hostMeta.eventId === "number" &&
    hostMeta.eventId <= (historyBoundaries.get(sessionId) ?? 0)
  )
    return;

  if (isReplay) {
    const sid = logSessionId(sessionId);
    let perf = replayPerf.get(sessionId);
    const now = performance.now();
    if (!perf) {
      perf = { firstAt: now, lastAt: now, count: 0 };
      replayPerf.set(sessionId, perf);
      perfLog(`[perf:replay] ${sid} first notification received`);
    }
    perf.lastAt = now;
    perf.count += 1;
    await handleReplay(sessionId, update);
  } else {
    // Usage is recorded only while the turn is live. Replay re-feeds every
    // `usage_update` the host persisted, and the ledger would take each one
    // as activity happening now: `lastActivityAt` jumps to today (Stats moves
    // the whole chat into today's bucket) and the whole ledger is serialized
    // to localStorage once per replayed turn. The chat's own token/cost
    // display is restored by `handleShared` on the replay path instead.
    recordUsageNotification(sessionId, update);
    observeWorkspaceToolCall(sessionId, update);
    if (update.sessionUpdate === "agent_message_chunk") {
      recordLiveAgentMessageChunk(sessionId);
    }
    await handleLive(sessionId, update);
  }
}

export function getReplayPerf(
  sessionId: string,
): { count: number; spanMs: number } | null {
  const perf = replayPerf.get(sessionId);
  if (!perf) return null;
  return { count: perf.count, spanMs: perf.lastAt - perf.firstAt };
}

export function clearReplayPerf(sessionId: string): void {
  replayPerf.delete(sessionId);
}

function getChunkMessageId(update: SessionUpdate): string | null {
  return "messageId" in update && typeof update.messageId === "string"
    ? update.messageId
    : null;
}

/**
 * The assistant message a live agent-side update streams into: the ACP
 * chunk's own `messageId` when the agent sends one, otherwise the reply id
 * the host stamps on every update of a turn (`hostTurn`).
 */
interface LiveAssistantMessageId {
  id: string;
  hostTurn: boolean;
}

function getLiveAssistantMessageId(
  update: SessionUpdate,
): LiveAssistantMessageId | null {
  const chunkMessageId = getChunkMessageId(update);
  if (chunkMessageId) {
    return { id: chunkMessageId, hostTurn: false };
  }
  const hostMessageId = getHostAssistantMessageId(update);
  return hostMessageId ? { id: hostMessageId, hostTurn: true } : null;
}

function isRunInterventionBoundary(update: SessionUpdate): boolean {
  const record: Record<string, unknown> = update;
  const meta = record._meta;
  if (!isRecord(meta)) {
    return false;
  }
  // The host marks a mid-run steer echo as the intervention boundary.
  const host = meta.distill;
  return isRecord(host) && host.steer === true;
}

function markSteerDelivered(sessionId: string, update: SessionUpdate): void {
  const store = useChatStore.getState();
  const messages = store.messagesBySession[sessionId];
  const deliveredMessageId =
    update.sessionUpdate === "user_message_chunk"
      ? getChunkMessageId(update)
      : null;
  const messageId =
    deliveredMessageId &&
    messages?.some((message) => message.id === deliveredMessageId)
      ? deliveredMessageId
      : messages?.find(
          // Goose picks up queued steers in request order. Match a boundary
          // that beats its response to the oldest steer still awaiting pickup
          // rather than the latest session-wide intervention boundary.
          (message) =>
            message.role === "user" &&
            message.metadata?.delivery === "steering",
        )?.id;
  if (!messageId) return;

  const resolvedMessageId = deliveredMessageId ?? messageId;
  store.replaceMessageId(sessionId, messageId, resolvedMessageId);
  store.updateMessage(sessionId, resolvedMessageId, (message) => ({
    ...message,
    metadata: {
      ...message.metadata,
      delivery: "steer",
    },
  }));
  store.setPendingInterventionBoundary(sessionId, {
    interventionMessageId: resolvedMessageId,
  });
}

function getReplayAssistantMessageMetadata(
  sessionId: string,
  update: SessionUpdate,
): Pick<MessageMetadata, "personaId" | "personaName"> | undefined {
  const updateMetadata = getReplayAssistantMetadata(update);
  if (updateMetadata) {
    return updateMetadata;
  }

  const personaId = useChatSessionStore
    .getState()
    .getSession(sessionId)?.personaId;
  if (!personaId) {
    return undefined;
  }

  const personaName = useAgentStore
    .getState()
    .getPersonaById(personaId)?.displayName;
  return {
    personaId,
    ...(personaName ? { personaName } : {}),
  };
}

/**
 * Thought chunks are token deltas: the bridges the app hosts stream reasoning
 * the same way they stream text, and the host persists every chunk verbatim,
 * so replay re-feeds those deltas. They are appended as they arrive — a delta
 * that repeats the tail of the reasoning so far (a second `1` after `…201`, a
 * closing `)` after `…(baz)`) is real text, not a duplicate.
 */
function upsertThinkingContent(content: MessageContent[], text: string): void {
  const last = content[content.length - 1];
  if (last?.type !== "thinking") {
    content.push({ type: "thinking", text });
    return;
  }

  last.text += text;
}

/**
 * Images a tool returned inline go to the message at once, in stream order.
 * Only a tool that named an image file waits for the file's bytes, and those
 * land after whatever the stream delivered meanwhile.
 */
function appendToolResultImages(
  update: Extract<
    SessionUpdate,
    { sessionUpdate: "tool_call" | "tool_call_update" }
  >,
  sink: (images: ImageContent[]) => void,
): Promise<void> | undefined {
  const images = extractToolResultImages(update);
  if (images.length === 0) return undefined;
  const inline = images.filter(
    (image): image is ImageContent =>
      typeof image.data === "string" && image.data.length > 0,
  );
  if (inline.length === images.length) {
    sink(inline);
    return undefined;
  }
  return hydrateToolResultImages(images).then((loaded) => {
    if (loaded.length > 0) sink(loaded);
  });
}

async function handleReplay(
  sessionId: string,
  update: SessionUpdate,
  sourceSessionId = sessionId,
): Promise<void> {
  if (handleSessionEvent(sessionId, update, true)) return;
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      handleReplayAssistantBoundary(sessionId, update);
      const msg = ensureReplayAssistantMessage(
        sessionId,
        getReplayAssistantMessageId(update),
        getReplayCreated(update),
        getReplayAssistantMessageMetadata(sourceSessionId, update),
      );
      if (update.content.type === "text" && "text" in update.content) {
        const last = msg.content[msg.content.length - 1];
        if (last?.type === "text") {
          (last as { type: "text"; text: string }).text += update.content.text;
        } else {
          msg.content.push({ type: "text", text: update.content.text });
        }
      } else if (update.content.type === "image") {
        msg.content.push({ ...update.content });
      }
      break;
    }

    case "agent_thought_chunk": {
      handleReplayAssistantBoundary(sessionId, update);
      if (update.content.type === "text" && "text" in update.content) {
        const msg = ensureReplayAssistantMessage(
          sessionId,
          getReplayAssistantMessageId(update),
          getReplayCreated(update),
          getReplayAssistantMessageMetadata(sourceSessionId, update),
        );
        upsertThinkingContent(msg.content, update.content.text);
      }
      break;
    }

    case "user_message_chunk": {
      completeReplayAssistantMessage(sessionId);
      replayAssistantMessageIds.delete(sessionId);
      replayAgentBoundaryActive.delete(sessionId);
      if (update.content.type !== "text" && update.content.type !== "image") {
        break;
      }
      const messageId = getReplayMessageId(update) ?? crypto.randomUUID();
      const metadata = getReplayUserMetadata(update);
      if (
        metadata?.delivery === "steer" &&
        isRepeatedReplaySteerBlock(sessionId, messageId, update.content)
      ) {
        break;
      }
      handleReplayUserMessageChunk(
        sessionId,
        messageId,
        update.content,
        getReplayCreated(update),
        metadata,
      );
      if (metadata?.delivery === "steer") {
        removeReplayAgentBoundaryCandidate(sessionId, messageId);
      } else {
        enqueueReplayAgentBoundaryCandidate(sessionId, messageId);
      }
      break;
    }

    case "tool_call": {
      handleReplayAssistantBoundary(sessionId, update);
      const created = getReplayCreated(update);
      const identity = getToolCallIdentity(update);
      const chainSummary = undefined;
      const msg = ensureReplayAssistantMessage(
        sessionId,
        getReplayAssistantMessageId(update),
        created,
        getReplayAssistantMessageMetadata(sourceSessionId, update),
      );
      const replayArguments = rawInputToArguments(update.rawInput);
      const replaySubagentContext =
        getSubagentToolCallContext(identity.toolName, replayArguments) ??
        resolveSubagentContext(
          identity.toolName,
          replayArguments,
          getReplayBuffer(sessionId) ?? [],
        );
      msg.content.push({
        type: "toolRequest",
        id: update.toolCallId,
        name: update.title,
        ...identity,
        arguments: replayArguments,
        status: "in_progress",
        ...toolCallUpdatePatch(update),
        startedAt: created ?? Date.now(),
        ...(chainSummary ? { chainSummary } : {}),
        ...(replaySubagentContext ?? {}),
      });
      msg.content = appendTerminalOutput(msg, update).content;
      break;
    }

    case "tool_call_update": {
      handleReplayAssistantBoundary(sessionId, update);
      const created = getReplayCreated(update);
      const replayMessageId = getReplayAssistantMessageId(update);
      const identity = getToolCallIdentity(update);
      const chainSummary = undefined;
      const trackedMessageId = getTrackedReplayAssistantMessageId(sessionId);
      const replayMsg = replayMessageId
        ? getBufferedMessage(sessionId, replayMessageId)
        : undefined;
      const trackedMsg =
        trackedMessageId && trackedMessageId !== replayMessageId
          ? getBufferedMessage(sessionId, trackedMessageId)
          : undefined;
      const existingMsg = findReplayMessageWithToolCall(
        sessionId,
        update.toolCallId,
      );
      const msg = existingMsg ?? replayMsg ?? trackedMsg;
      if (msg) {
        msg.content = appendTerminalOutput(msg, update).content;
        if (created !== undefined && !existingMsg && msg === replayMsg) {
          msg.created = created;
        }
        const patch = toolCallUpdatePatch(update);
        if (
          update.title ||
          Object.keys(identity).length > 0 ||
          Object.keys(patch).length > 0 ||
          chainSummary
        ) {
          const tc = msg.content.find(
            (c) => c.type === "toolRequest" && c.id === update.toolCallId,
          );
          if (tc && tc.type === "toolRequest") {
            Object.assign(tc as ToolRequestContent, {
              ...(update.title ? { name: update.title } : {}),
              ...identity,
              ...toolCallUpdatePatchFor(update, tc),
              ...(chainSummary ? { chainSummary } : {}),
            });
            // The wire tool name can arrive after the initial tool_call
            // (identity patched in by a later update); resolve the subagent
            // label now that we know what the tool is.
            if (
              identity.toolName &&
              (tc.subagentAgentName === undefined ||
                tc.subagentTaskLabel === undefined)
            ) {
              const lateContext =
                getSubagentToolCallContext(tc.toolName, tc.arguments) ??
                resolveSubagentContext(
                  tc.toolName,
                  tc.arguments,
                  getReplayBuffer(sessionId) ?? [],
                );
              if (lateContext) Object.assign(tc, lateContext);
            }
          }
        }
        if (update.status === "completed" || update.status === "failed") {
          const tc = msg.content.find(
            (c) => c.type === "toolRequest" && c.id === update.toolCallId,
          );
          if (tc && tc.type === "toolRequest") {
            const idx = msg.content.indexOf(tc);
            if (idx >= 0) {
              msg.content[idx] = {
                ...tc,
                ...identity,
                ...toolCallUpdatePatchFor(update, tc),
                status: update.status,
              } as ToolRequestContent;
            }
          }
          const resultText =
            extractToolResultText(update) ||
            (tc?.type === "toolRequest" ? (tc.terminalOutput ?? "") : "");
          msg.content.push({
            type: "toolResponse",
            ...(isRecord(update._meta?.distill) &&
            typeof update._meta.distill.resultEventId === "number"
              ? {
                  historyResult: {
                    sessionId: sourceSessionId,
                    eventId: update._meta.distill.resultEventId,
                  },
                }
              : {}),
            id: update.toolCallId,
            name: (tc as ToolRequestContent)?.name ?? "",
            result: resultText,
            structuredContent: extractToolStructuredContent(update),
            isError: update.status === "failed",
          });
          // Mirror the live branch: surface image blocks returned by the tool
          // so image-producing MCPs render inline on replay too. A tool-written
          // file is read from disk, and the ACP SDK does not wait for this
          // handler: the load can commit the replay before the read returns,
          // and then the image goes to the committed message in the store.
          await appendToolResultImages(update, (images) => {
            if (getReplayBuffer(sessionId)?.includes(msg)) {
              msg.content.push(...images);
              return;
            }
            useChatStore
              .getState()
              .updateMessage(sessionId, msg.id, (message) => ({
                ...message,
                content: [...message.content, ...images],
              }));
          });
        }
      }
      break;
    }

    case "session_info_update":
    case "config_option_update":
    case "usage_update":
      handleShared(sessionId, update);
      break;

    default:
      break;
  }
}

async function handleLive(
  sessionId: string,
  update: SessionUpdate,
): Promise<void> {
  if (handleSessionEvent(sessionId, update, false)) return;
  const store = useChatStore.getState();

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      if (isRunInterventionBoundary(update)) {
        flushBufferedStreamingUpdatesForSession(sessionId);
        markSteerDelivered(sessionId, update);
        store.startAssistantStreamAfterIntervention(sessionId);
        break;
      }

      const messageId = ensureLiveAssistantMessage(
        sessionId,
        getLiveAssistantMessageId(update),
      );

      if (update.content.type === "text" && "text" in update.content) {
        enqueueStreamingTextUpdate(sessionId, messageId, update.content.text);
      } else if (update.content.type === "image") {
        if (!isStreamingMessageOwnedByCurrentPrompt(sessionId, messageId)) {
          break;
        }
        // Live counterpart to the replay path (see the replay
        // agent_message_chunk handler above): append an image content block to
        // the streaming assistant message so agent-emitted images render inline
        // during the turn, not only after reload. Without this branch image
        // chunks were silently dropped live. Ensure buffered text lands before
        // the image so content order stays identical to notification order.
        flushBufferedStreamingUpdatesForSession(sessionId);
        store.setStreamingMessageId(sessionId, messageId);
        store.appendToStreamingMessage(sessionId, { ...update.content });
      }
      break;
    }

    case "agent_thought_chunk": {
      if (update.content.type === "text" && "text" in update.content) {
        const messageId = ensureLiveAssistantMessage(
          sessionId,
          getLiveAssistantMessageId(update),
        );
        enqueueStreamingThinkingUpdate(
          sessionId,
          messageId,
          update.content.text,
        );
      }
      break;
    }

    case "user_message_chunk": {
      if (isRunInterventionBoundary(update)) {
        flushBufferedStreamingUpdatesForSession(sessionId);
        markSteerDelivered(sessionId, update);
        store.startAssistantStreamAfterIntervention(sessionId);
      }
      break;
    }

    case "tool_call": {
      flushBufferedStreamingUpdatesForSession(sessionId);
      const messageId = ensureLiveAssistantMessage(
        sessionId,
        getLiveAssistantMessageId(update),
      );
      const identity = getToolCallIdentity(update);
      const chainSummary = undefined;

      const liveArguments = rawInputToArguments(update.rawInput);
      const liveSubagentContext =
        getSubagentToolCallContext(identity.toolName, liveArguments) ??
        resolveSubagentContext(
          identity.toolName,
          liveArguments,
          useChatStore.getState().messagesBySession[sessionId] ?? [],
        );
      const toolRequest: ToolRequestContent = {
        type: "toolRequest",
        id: update.toolCallId,
        name: update.title,
        ...identity,
        arguments: liveArguments,
        status: "in_progress",
        ...toolCallUpdatePatch(update),
        startedAt: Date.now(),
        ...(chainSummary ? { chainSummary } : {}),
        ...(liveSubagentContext ?? {}),
      };
      store.setStreamingMessageId(sessionId, messageId);
      store.appendToStreamingMessage(sessionId, toolRequest);
      if (hasTerminalOutput(update))
        store.updateMessage(sessionId, messageId, (msg) =>
          appendTerminalOutput(msg, update),
        );
      break;
    }

    case "tool_call_update": {
      const identity = getToolCallIdentity(update);
      const chainSummary = undefined;
      // Late-arriving updates (chain summaries, async titles) can target a
      // tool call whose request lives in an older message than the currently
      // streaming one. Patch the message that actually owns the tool call,
      // falling back to ensureLiveAssistantMessage only if we can't find it.
      const ownerMessageId = findLiveMessageIdWithToolCall(
        sessionId,
        update.toolCallId,
      );
      const messageId =
        ownerMessageId ??
        ensureLiveAssistantMessage(
          sessionId,
          getLiveAssistantMessageId(update),
        );

      const patch = toolCallUpdatePatch(update);
      const terminalData = getTerminalOutputData(update);
      if (
        terminalData &&
        !update.title &&
        !update.status &&
        Object.keys(identity).length === 0 &&
        Object.keys(patch).length === 0 &&
        !update.content?.length &&
        update.rawOutput == null
      ) {
        enqueueStreamingTerminalUpdate(
          sessionId,
          messageId,
          update.toolCallId,
          terminalData,
        );
        break;
      }
      // Completion and structural changes must observe all preceding output.
      flushBufferedStreamingUpdatesForSession(sessionId);
      if (terminalData)
        store.updateMessage(sessionId, messageId, (msg) =>
          appendTerminalOutput(msg, update),
        );

      if (
        update.title ||
        Object.keys(identity).length > 0 ||
        Object.keys(patch).length > 0 ||
        chainSummary
      ) {
        // The wire tool name can arrive after the initial tool_call
        // (identity patched in by a later update); resolve the subagent
        // label now that we know what the tool is.
        const storedArguments = identity.toolName
          ? (findLiveToolRequest(sessionId, messageId, update.toolCallId)
              ?.arguments ?? {})
          : {};
        const lateSubagentContext = identity.toolName
          ? (getSubagentToolCallContext(identity.toolName, storedArguments) ??
            resolveSubagentContext(
              identity.toolName,
              storedArguments,
              useChatStore.getState().messagesBySession[sessionId] ?? [],
            ))
          : undefined;
        store.updateMessage(sessionId, messageId, (msg) => ({
          ...msg,
          content: msg.content.map((c) =>
            c.type === "toolRequest" && c.id === update.toolCallId
              ? {
                  ...c,
                  ...(update.title ? { name: update.title } : {}),
                  ...identity,
                  ...toolCallUpdatePatchFor(update, c),
                  ...(chainSummary ? { chainSummary } : {}),
                  ...(lateSubagentContext ?? {}),
                }
              : c,
          ),
        }));
      }

      if (update.status === "completed" || update.status === "failed") {
        const { status: resolvedStatus } = update;
        const ownerMessage = useChatStore
          .getState()
          .messagesBySession[sessionId]?.find((m) => m.id === messageId);
        // Look up the request that this update belongs to by exact id —
        // sibling tools can complete out of order, so the latest unpaired
        // request isn't necessarily the one we're updating. Mirrors the
        // replay branch above.
        const toolRequest =
          ownerMessage?.content.find(
            (block): block is ToolRequestContent =>
              block.type === "toolRequest" && block.id === update.toolCallId,
          ) ?? null;

        store.updateMessage(sessionId, messageId, (msg) => ({
          ...msg,
          content: msg.content.map((block) =>
            block.type === "toolRequest" && block.id === update.toolCallId
              ? {
                  ...block,
                  ...identity,
                  ...toolCallUpdatePatchFor(update, block),
                  status: resolvedStatus,
                }
              : block,
          ),
        }));

        const resultText =
          extractToolResultText(update) || toolRequest?.terminalOutput || "";
        const toolResponse: ToolResponseContent = {
          type: "toolResponse",
          id: update.toolCallId,
          name: toolRequest?.name ?? update.title ?? "",
          result: resultText,
          structuredContent: extractToolStructuredContent(update),
          isError: update.status === "failed",
        };
        store.updateMessage(sessionId, messageId, (msg) => ({
          ...msg,
          content: [...msg.content, toolResponse],
        }));
        // Append any image blocks the tool returned so image-producing MCPs
        // (e.g. imagegenerator) and file-path generators (Grok image_gen)
        // render inline rather than only as text/JSON.
        await appendToolResultImages(update, (images) => {
          useChatStore
            .getState()
            .updateMessage(sessionId, messageId, (msg) => ({
              ...msg,
              content: [...msg.content, ...images],
            }));
        });
      }
      break;
    }

    case "session_info_update":
    case "config_option_update":
    case "usage_update":
      flushBufferedStreamingUpdatesForSession(sessionId);
      handleShared(sessionId, update);
      break;

    default:
      break;
  }
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function hostMeta(update: SessionUpdate): Record<string, unknown> | null {
  if (
    !isRecord(update) ||
    !isRecord(update._meta) ||
    !isRecord(update._meta.distill)
  ) {
    return null;
  }
  return update._meta.distill;
}

function recordUsageNotification(
  sessionId: string,
  update: SessionUpdate,
): void {
  const kind = (update as { sessionUpdate?: string }).sessionUpdate;
  if (kind === "usage_update") {
    const usage = update as SessionUpdate & {
      sessionUpdate: "usage_update";
      used?: number;
      cost?: { amount?: number | null; currency?: string | null } | null;
      accumulatedInputTokens?: number;
      accumulatedOutputTokens?: number;
      accumulatedCost?: number | null;
    };
    const meta = hostMeta(update);
    const inputTokens =
      readNumber(usage.accumulatedInputTokens) ??
      readNumber(meta?.accumulatedInputTokens);
    const outputTokens =
      readNumber(usage.accumulatedOutputTokens) ??
      readNumber(meta?.accumulatedOutputTokens);
    let costUsd: number | null | undefined;
    if (usage.cost === undefined) {
      costUsd =
        readNumber(usage.accumulatedCost) ?? readNumber(meta?.accumulatedCost);
    } else if (typeof usage.cost?.amount === "number") {
      costUsd = usage.cost.amount;
    } else {
      costUsd = null;
    }
    if (inputTokens == null && outputTokens == null && costUsd === undefined) {
      return;
    }
    recordAcpSessionUsage(sessionId, {
      mode: "replace",
      inputTokens,
      outputTokens,
      totalTokens:
        inputTokens != null || outputTokens != null
          ? (inputTokens ?? 0) + (outputTokens ?? 0)
          : undefined,
      costUsd,
      // The ledger needs the unit: a bridge reporting credits or EUR must not
      // have its amounts summed into the "$" figures on the stats page.
      costCurrency: usage.cost?.currency ?? null,
    });
    return;
  }

  if (kind !== "message_usage") {
    return;
  }
  const usage = (update as unknown as { usage?: unknown }).usage;
  if (!isRecord(usage)) {
    return;
  }
  const cacheTokens =
    (readNumber(usage.cacheReadTokens) ?? 0) +
    (readNumber(usage.cacheWriteTokens) ?? 0);
  const elapsedMs = readNumber(usage.elapsedMs);
  recordAcpSessionUsage(sessionId, {
    mode: "add",
    inputTokens: readNumber(usage.inputTokens) ?? 0,
    outputTokens: readNumber(usage.outputTokens) ?? 0,
    cacheTokens,
    costUsd: readNumber(usage.cost),
    turnsDelta: 1,
  });
  if (elapsedMs && elapsedMs > 0) {
    if (!isBenchmarkSession(sessionId))
      addSessionWorkedMs(sessionId, elapsedMs);
  }
}

function handleShared(sessionId: string, update: SessionUpdate): void {
  switch (update.sessionUpdate) {
    case "session_info_update": {
      handleSessionInfoUpdate(sessionId, update);
      break;
    }

    case "config_option_update": {
      applyChatSessionConfigOptionsSnapshot(sessionId, update, {
        origin: "notification",
      });
      break;
    }

    case "usage_update": {
      const usage = update as SessionUpdate & {
        sessionUpdate: "usage_update";
        used?: number;
        size?: number;
        contextLimit?: number;
        cost?: {
          amount?: number | null;
          currency?: string | null;
          _meta?: Record<string, unknown> | null;
        } | null;
        accumulatedInputTokens?: number;
        accumulatedOutputTokens?: number;
        accumulatedCost?: number | null;
      };

      // The standard ACP usage_update carries cumulative session cost (USD)
      // in `cost.amount`. Distinguish three cases so we don't drop a
      // previously-displayed cost when the backend simply omits cost on a
      // later usage update:
      //   - `cost` omitted (undefined)        -> preserve existing value
      //   - explicit `cost: null` / null amount -> clear (no pricing)
      //   - finite amount                      -> update
      // Only including `accumulatedCost` in the partial when cost is present
      // lets the store's preserve-on-`undefined` behavior kick in.
      let accumulatedCost: number | null | undefined;
      let costBilling: SessionCostBilling | null | undefined;
      if (usage.cost === undefined) {
        accumulatedCost =
          typeof usage.accumulatedCost === "number"
            ? usage.accumulatedCost
            : undefined;
        costBilling =
          accumulatedCost === undefined
            ? undefined
            : sessionCostBillingForAmount(accumulatedCost);
      } else if (typeof usage.cost?.amount === "number") {
        accumulatedCost = usage.cost.amount;
        costBilling = sessionCostBillingForAmount(
          accumulatedCost,
          readUsageCostBilledFlag(usage.cost),
        );
      } else {
        accumulatedCost = null;
        costBilling = null;
      }

      const contextLimit = usage.size ?? usage.contextLimit;
      const partial: Partial<TokenState> = {
        ...(typeof usage.used === "number"
          ? { accumulatedTotal: usage.used }
          : {}),
        ...(typeof contextLimit === "number" ? { contextLimit } : {}),
        ...(typeof usage.accumulatedInputTokens === "number"
          ? { accumulatedInput: usage.accumulatedInputTokens }
          : {}),
        ...(typeof usage.accumulatedOutputTokens === "number"
          ? { accumulatedOutput: usage.accumulatedOutputTokens }
          : {}),
        ...(accumulatedCost !== undefined ? { accumulatedCost } : {}),
        ...(costBilling !== undefined ? { costBilling } : {}),
      };
      const store = useChatStore.getState();
      if (store.loadingSessionIds.has(sessionId)) {
        bufferReplayTokenState(
          sessionId,
          partial,
          store.sessionStateById[sessionId]?.tokenState,
        );
      } else {
        store.updateTokenState(sessionId, partial);
      }
      break;
    }

    default:
      break;
  }
}

function findStreamingMessageId(sessionId: string): string | null {
  return useChatStore.getState().getSessionRuntime(sessionId)
    .streamingMessageId;
}

/**
 * Locate the live message that owns a given tool call id by scanning
 * `messagesBySession` from the most recent message backwards. Used by
 * `tool_call_update` to keep late-arriving updates (chain summaries, async
 * titles, status flips) anchored on the request's original message even when
 * the streaming pointer has moved on to the next assistant turn.
 */
function findLiveMessageIdWithToolCall(
  sessionId: string,
  toolCallId: string,
): string | null {
  const messages = useChatStore.getState().messagesBySession[sessionId];
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (
      messages[i].content.some(
        (c) => c.type === "toolRequest" && c.id === toolCallId,
      )
    ) {
      return messages[i].id;
    }
  }
  return null;
}

function findLiveToolRequest(
  sessionId: string,
  messageId: string,
  toolCallId: string,
): ToolRequestContent | undefined {
  const messages = useChatStore.getState().messagesBySession[sessionId];
  const message = messages?.find((m) => m.id === messageId);
  return message?.content.find(
    (c): c is ToolRequestContent =>
      c.type === "toolRequest" && c.id === toolCallId,
  );
}

function ensureLiveAssistantMessage(
  sessionId: string,
  preferred?: LiveAssistantMessageId | null,
): string {
  const store = useChatStore.getState();
  const existingStreamingMessageId = findStreamingMessageId(sessionId);
  const messages = store.messagesBySession[sessionId] ?? [];
  const activePreset = getActiveMessagePreset(sessionId);
  const preferredMessageId = preferred?.id ?? null;

  if (
    preferredMessageId &&
    preferredMessageId !== existingStreamingMessageId &&
    messages.some((message) => message.id === preferredMessageId)
  ) {
    registerStreamingMessageOwner(sessionId, preferredMessageId);
    return preferredMessageId;
  }

  if (
    existingStreamingMessageId &&
    messages.some((message) => message.id === existingStreamingMessageId)
  ) {
    const hostTurnMessageId =
      preferred?.hostTurn && preferred.id !== existingStreamingMessageId
        ? preferred.id
        : null;
    if (!hostTurnMessageId) {
      if (activePreset?.metadata) {
        store.updateMessage(
          sessionId,
          existingStreamingMessageId,
          (message) => ({
            ...message,
            metadata: {
              ...message.metadata,
              ...activePreset.metadata,
            },
          }),
        );
      }
      return existingStreamingMessageId;
    }
    if (adoptHostTurnMessageId(sessionId, hostTurnMessageId)) {
      return hostTurnMessageId;
    }
  }

  const messageId =
    preferredMessageId ??
    activePreset?.messageId ??
    existingStreamingMessageId ??
    crypto.randomUUID();

  if (!messages.some((message) => message.id === messageId)) {
    store.addMessage(sessionId, {
      id: messageId,
      role: "assistant",
      created: Date.now(),
      content: [],
      metadata: {
        userVisible: true,
        agentVisible: true,
        completionStatus: "inProgress",
        ...activePreset?.metadata,
      },
    });
  }

  registerStreamingMessageOwner(sessionId, messageId);
  store.setPendingAssistantProvider(sessionId, null);
  store.setStreamingMessageId(sessionId, messageId);
  clearActiveMessageId(sessionId);

  return messageId;
}

/**
 * The host names each turn's reply (`assistantMessageId`). When the message
 * the renderer is streaming into has no content yet (the placeholder started
 * at a steer boundary), it becomes that reply: it is renamed so everything
 * keyed by message id (wave plans, brigade nodes, a later reload) agrees on
 * the host's id. A streaming message that already has content belongs to an
 * earlier turn: it is completed, and the caller starts the new reply.
 */
function adoptHostTurnMessageId(
  sessionId: string,
  hostTurnMessageId: string,
): boolean {
  flushBufferedStreamingUpdatesForSession(sessionId);
  const store = useChatStore.getState();
  const streamingMessageId = findStreamingMessageId(sessionId);
  const streamingMessage = streamingMessageId
    ? store.messagesBySession[sessionId]?.find(
        (message) => message.id === streamingMessageId,
      )
    : undefined;
  if (!streamingMessage || streamingMessage.role !== "assistant") {
    return false;
  }
  if (streamingMessage.content.length > 0) {
    store.updateMessage(
      sessionId,
      streamingMessage.id,
      completeAssistantMessage,
    );
    return false;
  }

  const activePreset = getActiveMessagePreset(sessionId);
  store.replaceMessageId(sessionId, streamingMessage.id, hostTurnMessageId);
  if (activePreset?.metadata) {
    store.updateMessage(sessionId, hostTurnMessageId, (message) => ({
      ...message,
      metadata: {
        ...message.metadata,
        ...activePreset.metadata,
      },
    }));
  }
  registerStreamingMessageOwner(sessionId, hostTurnMessageId);
  store.setStreamingMessageId(sessionId, hostTurnMessageId);
  return true;
}

export function clearMessageTracking(): void {
  loadingLiveUpdates.clear();
  historyBoundaries.clear();
  replayPerf.clear();
  pendingReplayAgentBoundaryCandidates.clear();
  replayAssistantMessageIds.clear();
  replayAgentBoundaryActive.clear();
  clearStreamingMessageOwners();
  clearActiveMessageTracking();
  clearReplayAssistantTracking();
  clearSkillReplayChips();
  clearWorkspaceToolCallObservations();
}

/**
 * The per-session counterpart of `clearMessageTracking`, for a session the
 * chat store let go of. An evicted session is settled and not loading; a
 * cleaned-up one was archived or deleted. A chunk that still trails in for
 * either is bound again to whoever owns the session at that point.
 */
export function forgetSessionMessageTracking(sessionId: string): void {
  loadingLiveUpdates.delete(sessionId);
  historyBoundaries.delete(sessionId);
  clearSkillReplayChips(sessionId);
  clearReplaySessionTracking(sessionId);
  clearReplayAssistantTracking(sessionId);
  releaseStreamingSession(sessionId);
  clearWorkspaceToolCallObservations(sessionId);
}

onChatSessionReleased(forgetSessionMessageTracking);

/**
 * The app answers permission requests itself (`answerPermissionRequest`), and
 * one of those answers is worth a transcript row: when a harness offers only
 * permanent options there is nothing to refuse once with, and the `cancelled`
 * outcome ACP leaves us ends the whole turn. Without this the operator sees a
 * turn that simply stopped, and the only trace is a line in distill.log.
 */
export function reportPermissionAnswer(
  report: AcpPermissionAnswerReport,
): void {
  if (report.answer !== "cancelled" || !report.sessionId) return;
  useChatStore.getState().addMessage(
    report.sessionId,
    createSystemNotificationMessage(
      i18n.t("chat:permissionRequest.cancelledTurn", {
        tool: report.toolLabel ?? "",
      }),
      "warning",
    ),
  );
}

const handler: AcpNotificationHandler = {
  handleSessionNotification,
  reportPermissionAnswer,
};

export default handler;
