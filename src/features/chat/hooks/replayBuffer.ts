/**
 * Replay buffering for session history loading.
 *
 * During session history replay, the backend fires individual Tauri events for
 * every historical message. Previously each event called store.addMessage(),
 * creating a new Zustand state object and triggering a React re-render of the
 * full message list — O(N²) work for N messages.
 *
 * Instead, replay events now accumulate messages in this module-level buffer.
 * When the session finishes loading (loadingSessionIds removes the id), the
 * buffer is flushed as a single store.setMessages() call — O(1) re-render.
 */
import type { Message } from "@/shared/types/messages";
import { INITIAL_TOKEN_STATE, type TokenState } from "@/shared/types/chat";
import { mergeTokenState } from "@/features/chat/lib/tokenState";

const replayBuffers = new Map<string, Message[]>();
const replayTokenStates = new Map<string, TokenState>();

/** Usage is part of the replay too: publishing every historical sample wakes
 * the chat controller and renders the loading screen once per sample. */
export function bufferReplayTokenState(
  sessionId: string,
  partial: Partial<TokenState>,
  initial: TokenState = INITIAL_TOKEN_STATE,
): void {
  ensureReplayBuffer(sessionId);
  replayTokenStates.set(
    sessionId,
    mergeTokenState(replayTokenStates.get(sessionId) ?? initial, partial),
  );
}

export function getReplayTokenState(sessionId: string): TokenState | undefined {
  return replayTokenStates.get(sessionId);
}

export function ensureReplayBuffer(sessionId: string): Message[] {
  let buffer = replayBuffers.get(sessionId);
  if (!buffer) {
    buffer = [];
    replayBuffers.set(sessionId, buffer);
  }
  return buffer;
}

export function getBufferedMessage(
  sessionId: string,
  messageId: string,
): Message | undefined {
  return replayBuffers.get(sessionId)?.find((m) => m.id === messageId);
}

export function getReplayBuffer(sessionId: string): Message[] | undefined {
  return replayBuffers.get(sessionId);
}

export function getAndDeleteReplayBuffer(
  sessionId: string,
): Message[] | undefined {
  const buffer = replayBuffers.get(sessionId);
  clearReplayBuffer(sessionId);
  return buffer;
}

/** Discard the replay buffer for a session without returning it. */
export function clearReplayBuffer(sessionId: string): void {
  replayBuffers.delete(sessionId);
  replayTokenStates.delete(sessionId);
}
