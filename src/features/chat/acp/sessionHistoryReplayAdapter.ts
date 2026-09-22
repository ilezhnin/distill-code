import { setSessionHistoryReplayHandler } from "@/shared/api/acpSessionRegistry";
import { clearReplayBuffer } from "@/features/chat/hooks/replayBuffer";
import { replaceMessagesFromSessionReplay } from "@/features/chat/lib/sessionReplayReplacement";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { perfLog } from "@/shared/lib/perfLog";

/**
 * How a chat's history is treated when a `session/load` was issued to prepare
 * the session, not to show it.
 *
 * The host answers every `session/load` by replaying the transcript as
 * `session/update` notifications. The notification handler tells replay from
 * live traffic by `loadingSessionIds`, and only the activation loader set it —
 * so a load issued by the session registry (a provider or model pick on a
 * chat this renderer had not opened yet, right after a reload) arrived as live
 * traffic. Live handling rebuilds the agent's replies and tool calls, and
 * ignores every `user_message_chunk`, because live user chunks are echoes of
 * what the composer already added. The store then held the agent's half of
 * the conversation; the activation loader saw messages and skipped its own
 * replay; the operator's messages were gone from the screen until the next
 * cold start, though the host had every one of them.
 *
 * Here the load runs as a replay: buffered while it is in flight, then written
 * to the store as the transcript. When another loader already owns this
 * session's replay (it set the loading flag and will flush the buffer itself),
 * this load's copy of the history is dropped instead, so the owner's buffer
 * does not end up with the transcript twice.
 */
async function loadWithHistoryAsReplay<T>(
  sessionId: string,
  load: () => Promise<T>,
): Promise<T> {
  const store = useChatStore.getState();
  const sid = sessionId.slice(0, 8);
  if (store.loadingSessionIds.has(sessionId)) {
    try {
      return await load();
    } finally {
      clearReplayBuffer(sessionId);
      perfLog(`[perf:prepare] ${sid} history replay left to its loader`);
    }
  }
  clearReplayBuffer(sessionId);
  store.setSessionLoading(sessionId, true);
  try {
    return await load();
  } finally {
    const result = replaceMessagesFromSessionReplay(sessionId, {
      // An empty replay of a chat that shows messages is not a reason to blank
      // it, and an empty chat may well have no history yet.
      historyExpectation: "unknown",
    });
    useChatStore.getState().setSessionLoading(sessionId, false);
    perfLog(
      `[perf:prepare] ${sid} history replay ${result.status}${
        result.status === "replaced" ? ` (${result.messages.length} msgs)` : ""
      }`,
    );
  }
}

export function registerChatSessionHistoryReplayHandler(): void {
  setSessionHistoryReplayHandler(loadWithHistoryAsReplay);
}
