import { SNIPPET_SCAN_LIMIT } from "@/features/chat/lib/messageSnippet";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  type StreamingMessageUpdate,
  type StreamingMessageUpdateMode,
  useChatStore,
} from "@/features/chat/stores/chatStore";
import { isTextContent } from "@/shared/types/messages";
import { getSessionPromptOwner } from "@/features/chat/lib/sessionPromptOwnership";

const LIVE_SUBTITLE_THROTTLE_MS = 1_000;
const FRAME_FALLBACK_MS = 16;

type TimerId = ReturnType<typeof setTimeout>;

interface BufferedTextUpdate {
  kind: "text";
  sessionId: string;
  messageId: string;
  owner: symbol | null;
  text: string;
}

interface BufferedThinkingUpdate {
  kind: "thinking";
  sessionId: string;
  messageId: string;
  owner: symbol | null;
  chunks: string[];
}

interface BufferedTerminalUpdate {
  kind: "terminal";
  sessionId: string;
  messageId: string;
  owner: symbol | null;
  toolCallId: string;
  data: string;
}

type BufferedStreamingUpdate =
  | BufferedTextUpdate
  | BufferedThinkingUpdate
  | BufferedTerminalUpdate;

interface PendingSubtitleUpdate {
  text: string;
  timerId: TimerId | null;
  lastPublishedAt: number;
}

/**
 * How many messages per session keep the prompt they were bound to. A chunk
 * for a message that fell out is bound again to whoever owns the session then,
 * which only differs from its old binding if the message still streams after
 * this many newer replies started in the same chat. Without a bound the map
 * kept an entry for every streamed reply of every chat, because a message
 * bound to no prompt (a turn this window did not send) was never released.
 */
const STREAM_OWNERS_PER_SESSION_LIMIT = 64;

const bufferedStreamingUpdates: BufferedStreamingUpdate[] = [];
/**
 * Per session, per message: the prompt that owned the session when the message
 * began streaming, or `null` when none did.
 */
const streamOwnersBySession = new Map<string, Map<string, symbol | null>>();
const pendingSubtitleUpdates = new Map<string, PendingSubtitleUpdate>();
let scheduledFrameId: number | null = null;
let scheduledTimeoutId: TimerId | null = null;

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function requestFrame(callback: () => void): void {
  if (
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function"
  ) {
    scheduledFrameId = window.requestAnimationFrame(() => {
      scheduledFrameId = null;
      callback();
    });
    return;
  }

  scheduledTimeoutId = setTimeout(() => {
    scheduledTimeoutId = null;
    callback();
  }, FRAME_FALLBACK_MS);
}

function cancelScheduledFrame(): void {
  if (
    scheduledFrameId !== null &&
    typeof window !== "undefined" &&
    typeof window.cancelAnimationFrame === "function"
  ) {
    window.cancelAnimationFrame(scheduledFrameId);
  }
  scheduledFrameId = null;

  if (scheduledTimeoutId !== null) {
    clearTimeout(scheduledTimeoutId);
  }
  scheduledTimeoutId = null;
}

function bindStreamOwner(
  sessionId: string,
  messageId: string,
  owner: symbol | null,
): void {
  let owners = streamOwnersBySession.get(sessionId);
  if (!owners) {
    owners = new Map();
    streamOwnersBySession.set(sessionId, owners);
  }
  owners.set(messageId, owner);
  if (owners.size > STREAM_OWNERS_PER_SESSION_LIMIT) {
    const oldest = owners.keys().next();
    if (!oldest.done) owners.delete(oldest.value);
  }
}

export function clearStreamingMessageOwners(): void {
  streamOwnersBySession.clear();
}

export function registerStreamingMessageOwner(
  sessionId: string,
  messageId: string,
): void {
  if (!streamOwnersBySession.get(sessionId)?.has(messageId)) {
    bindStreamOwner(sessionId, messageId, getSessionPromptOwner(sessionId));
  }
}

/**
 * A prompt's settlement ends the renderer's side of the turn, not the host's:
 * a rejected `session/prompt` (a closed socket, a host error) leaves the bridge
 * running, and the rest of that reply still arrives. Those chunks target a
 * message whose owner symbol has just been released, and no flush can ever
 * match it again — they would pile up in `bufferedStreamingUpdates` unrendered
 * until the chat is cleared. Forgetting the released owner's messages lets the
 * next chunk re-bind them to whoever owns the session then (nobody, or the
 * prompt that took over), so the remainder of the reply is applied and the
 * buffer stays bounded.
 */
export function releaseStreamingMessageOwner(
  sessionId: string,
  owner: symbol,
): void {
  const owners = streamOwnersBySession.get(sessionId);
  if (!owners) return;
  for (const [messageId, value] of owners) {
    if (value === owner) {
      owners.delete(messageId);
    }
  }
  if (owners.size === 0) {
    streamOwnersBySession.delete(sessionId);
  }
}

/**
 * Forgets what this module keeps for a session the chat store let go of
 * (evicted or cleaned up). A throttled subtitle still waiting on its timer is
 * published now, as the timer would have done; one already published is not
 * published again, since something newer may have replaced it since.
 */
export function releaseStreamingSession(sessionId: string): void {
  streamOwnersBySession.delete(sessionId);
  const pending = pendingSubtitleUpdates.get(sessionId);
  if (!pending) return;
  pendingSubtitleUpdates.delete(sessionId);
  if (pending.timerId !== null) {
    clearTimeout(pending.timerId);
    updateLiveSubtitle(sessionId, pending.text);
  }
}

function resolveStreamOwner(sessionId: string, messageId: string) {
  const owners = streamOwnersBySession.get(sessionId);
  if (owners?.has(messageId)) {
    return owners.get(messageId) ?? null;
  }

  const owner = getSessionPromptOwner(sessionId);
  bindStreamOwner(sessionId, messageId, owner);
  return owner;
}

export function isStreamingMessageOwnedByCurrentPrompt(
  sessionId: string,
  messageId: string,
): boolean {
  return (
    resolveStreamOwner(sessionId, messageId) ===
    getSessionPromptOwner(sessionId)
  );
}

function scheduleBufferedFlush(): void {
  if (scheduledFrameId !== null || scheduledTimeoutId !== null) {
    return;
  }

  requestFrame(flushAllBufferedStreamingUpdates);
}

function getAccumulatedAssistantText(
  sessionId: string,
  messageId: string,
): string | null {
  const streamingMessage = useChatStore
    .getState()
    .messagesBySession[sessionId]?.findLast(
      (message) => message.id === messageId,
    );
  if (!streamingMessage) {
    return null;
  }

  let accumulatedText = "";
  for (const block of streamingMessage.content) {
    if (!isTextContent(block)) continue;
    if (accumulatedText.length > 0) accumulatedText += "\n";
    accumulatedText += block.text.slice(
      0,
      SNIPPET_SCAN_LIMIT - accumulatedText.length,
    );
    if (accumulatedText.length >= SNIPPET_SCAN_LIMIT) break;
  }

  return accumulatedText;
}

function updateLiveSubtitle(sessionId: string, text: string): void {
  useChatSessionStore.getState().updateSessionSubtitleFromText(sessionId, text);
}

function publishLiveSubtitle(sessionId: string, text: string): void {
  updateLiveSubtitle(sessionId, text);
  const pending = pendingSubtitleUpdates.get(sessionId);
  if (pending) {
    pending.text = text;
    pending.lastPublishedAt = nowMs();
  } else {
    pendingSubtitleUpdates.set(sessionId, {
      text,
      timerId: null,
      lastPublishedAt: nowMs(),
    });
  }
}

export function scheduleLiveSubtitleUpdate(
  sessionId: string,
  text: string,
): void {
  const now = nowMs();
  const pending = pendingSubtitleUpdates.get(sessionId);
  if (!pending) {
    pendingSubtitleUpdates.set(sessionId, {
      text,
      timerId: null,
      lastPublishedAt: now,
    });
    updateLiveSubtitle(sessionId, text);
    return;
  }

  pending.text = text;
  const elapsedMs = now - pending.lastPublishedAt;
  if (elapsedMs >= LIVE_SUBTITLE_THROTTLE_MS) {
    if (pending.timerId !== null) {
      clearTimeout(pending.timerId);
      pending.timerId = null;
    }
    publishLiveSubtitle(sessionId, text);
    return;
  }

  if (pending.timerId !== null) {
    return;
  }

  pending.timerId = setTimeout(() => {
    pending.timerId = null;
    publishLiveSubtitle(sessionId, pending.text);
  }, LIVE_SUBTITLE_THROTTLE_MS - elapsedMs);
}

export function flushLiveSubtitleUpdate(sessionId: string): void {
  const pending = pendingSubtitleUpdates.get(sessionId);
  if (!pending) {
    return;
  }

  if (pending.timerId !== null) {
    clearTimeout(pending.timerId);
  }
  pendingSubtitleUpdates.delete(sessionId);
  updateLiveSubtitle(sessionId, pending.text);
}

export function clearLiveSubtitleUpdate(sessionId: string): void {
  const pending = pendingSubtitleUpdates.get(sessionId);
  if (pending?.timerId != null) {
    clearTimeout(pending.timerId);
  }
  pendingSubtitleUpdates.delete(sessionId);
}

export function enqueueStreamingTextUpdate(
  sessionId: string,
  messageId: string,
  text: string,
): void {
  if (!text) {
    return;
  }

  const owner = resolveStreamOwner(sessionId, messageId);
  const latest = bufferedStreamingUpdates.at(-1);
  if (
    latest?.kind === "text" &&
    latest.sessionId === sessionId &&
    latest.messageId === messageId &&
    latest.owner === owner
  ) {
    latest.text += text;
  } else {
    bufferedStreamingUpdates.push({
      kind: "text",
      sessionId,
      messageId,
      owner,
      text,
    });
  }
  scheduleBufferedFlush();
}

export function enqueueStreamingThinkingUpdate(
  sessionId: string,
  messageId: string,
  text: string,
): void {
  if (!text) {
    return;
  }

  const owner = resolveStreamOwner(sessionId, messageId);
  const latest = bufferedStreamingUpdates.at(-1);
  if (
    latest?.kind === "thinking" &&
    latest.sessionId === sessionId &&
    latest.messageId === messageId &&
    latest.owner === owner
  ) {
    latest.chunks.push(text);
  } else {
    bufferedStreamingUpdates.push({
      kind: "thinking",
      sessionId,
      messageId,
      owner,
      chunks: [text],
    });
  }
  scheduleBufferedFlush();
}

/** Coalesce command output with the text stream instead of rendering each line. */
export function enqueueStreamingTerminalUpdate(
  sessionId: string,
  messageId: string,
  toolCallId: string,
  data: string,
): void {
  if (!data) return;
  const owner = resolveStreamOwner(sessionId, messageId);
  const latest = bufferedStreamingUpdates.at(-1);
  if (
    latest?.kind === "terminal" &&
    latest.sessionId === sessionId &&
    latest.messageId === messageId &&
    latest.toolCallId === toolCallId &&
    latest.owner === owner
  ) {
    latest.data += data;
  } else {
    bufferedStreamingUpdates.push({
      kind: "terminal",
      sessionId,
      messageId,
      toolCallId,
      data,
      owner,
    });
  }
  scheduleBufferedFlush();
}

function toStoreUpdate(
  update: BufferedStreamingUpdate,
): StreamingMessageUpdate {
  if (update.kind === "terminal") {
    return {
      kind: "terminal",
      sessionId: update.sessionId,
      messageId: update.messageId,
      toolCallId: update.toolCallId,
      data: update.data,
    };
  }
  return update.kind === "text"
    ? {
        kind: "text",
        sessionId: update.sessionId,
        messageId: update.messageId,
        text: update.text,
      }
    : {
        kind: "thinking",
        sessionId: update.sessionId,
        messageId: update.messageId,
        chunks: update.chunks,
      };
}

function applyBufferedUpdates(
  updates: readonly BufferedStreamingUpdate[],
  mode: StreamingMessageUpdateMode,
): void {
  const storeUpdates = updates.map(toStoreUpdate);
  const latestTextUpdateBySession = new Map<string, BufferedTextUpdate>();

  if (mode === "active-stream") {
    for (const update of updates) {
      if (update.kind !== "text") continue;
      latestTextUpdateBySession.set(update.sessionId, update);
    }
  }

  if (storeUpdates.length === 0) return;
  useChatStore.getState().appendStreamingMessageUpdates(storeUpdates, {
    mode,
  });

  for (const update of latestTextUpdateBySession.values()) {
    const accumulatedText = getAccumulatedAssistantText(
      update.sessionId,
      update.messageId,
    );
    if (accumulatedText !== null) {
      scheduleLiveSubtitleUpdate(update.sessionId, accumulatedText);
    }
  }
}

export function flushAllBufferedStreamingUpdates(): void {
  cancelScheduledFrame();

  const currentUpdates: BufferedStreamingUpdate[] = [];
  for (
    let index = bufferedStreamingUpdates.length - 1;
    index >= 0;
    index -= 1
  ) {
    const update = bufferedStreamingUpdates[index];
    if (update && update.owner === getSessionPromptOwner(update.sessionId)) {
      currentUpdates.unshift(update);
      bufferedStreamingUpdates.splice(index, 1);
    }
  }

  applyBufferedUpdates(currentUpdates, "active-stream");
}

export function flushBufferedStreamingUpdatesForSession(
  sessionId: string,
  options: { flushSubtitle?: boolean; owner?: symbol | null } = {},
): void {
  const matches = (update: BufferedStreamingUpdate) =>
    update.sessionId === sessionId &&
    ("owner" in options
      ? update.owner === options.owner
      : update.owner === getSessionPromptOwner(sessionId));
  const sessionUpdates = bufferedStreamingUpdates.filter(matches);
  if (sessionUpdates.length === 0) {
    if (
      options.flushSubtitle &&
      (!("owner" in options) ||
        options.owner === getSessionPromptOwner(sessionId))
    ) {
      flushLiveSubtitleUpdate(sessionId);
    }
    return;
  }

  for (
    let index = bufferedStreamingUpdates.length - 1;
    index >= 0;
    index -= 1
  ) {
    const update = bufferedStreamingUpdates[index];
    if (update && matches(update)) {
      bufferedStreamingUpdates.splice(index, 1);
    }
  }

  if (bufferedStreamingUpdates.length === 0) {
    cancelScheduledFrame();
  }

  const mode: StreamingMessageUpdateMode =
    !("owner" in options) || options.owner === getSessionPromptOwner(sessionId)
      ? "active-stream"
      : "settled-stream";
  applyBufferedUpdates(sessionUpdates, mode);

  if (
    options.flushSubtitle &&
    (!("owner" in options) ||
      options.owner === getSessionPromptOwner(sessionId))
  ) {
    flushLiveSubtitleUpdate(sessionId);
  }
}

export function clearBufferedStreamingUpdatesForSession(
  sessionId: string,
  options: { owner?: symbol | null } = {},
): void {
  const matches = (update: BufferedStreamingUpdate) =>
    update.sessionId === sessionId &&
    (!("owner" in options) || update.owner === options.owner);
  for (
    let index = bufferedStreamingUpdates.length - 1;
    index >= 0;
    index -= 1
  ) {
    const update = bufferedStreamingUpdates[index];
    if (update && matches(update)) {
      bufferedStreamingUpdates.splice(index, 1);
    }
  }
  if (bufferedStreamingUpdates.length === 0) {
    cancelScheduledFrame();
  }
  if (
    !("owner" in options) ||
    options.owner === getSessionPromptOwner(sessionId)
  ) {
    clearLiveSubtitleUpdate(sessionId);
  }
}
