import { useEffect, useRef, useState } from "react";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  chatAutoLoadCursorKey,
  chatAutoLoadPageLanded,
  chatAutoLoadRetryDelayMs,
} from "@/features/sessions/lib/sidebarChatAutoLoad";

/**
 * Reads further pages of the chat list until every chat that is not archived
 * is in, and leaves the archive behind them to whoever opens it.
 *
 * A chat stays reachable until it is archived, however long ago it was last
 * used. Stopping at a count of rows instead left a project whose chats were
 * all older than the newest few dozen looking empty, though none of them had
 * been archived.
 */
export function useSidebarChatAutoLoad(enabled: boolean): void {
  const hasMoreSessions = useChatSessionStore((s) => s.hasMoreActiveSessions);
  const isLoadingMoreSessions = useChatSessionStore(
    (s) => s.isLoadingMoreSessions,
  );
  const sessionPageCursor = useChatSessionStore((s) => s.sessionPageCursor);
  const loadMoreSessions = useChatSessionStore((s) => s.loadMoreSessions);
  const attemptedChatLoadMoreCursorRef = useRef<string | null>(null);
  const chatLoadMoreRetryTimerRef = useRef<number | null>(null);
  // Failed attempts for the current cursor. Part of the attempt key, so a
  // scheduled retry re-runs the auto-load effect for the same cursor.
  const [chatLoadMoreAttempt, setChatLoadMoreAttempt] = useState(0);
  useEffect(
    () => () => {
      if (chatLoadMoreRetryTimerRef.current != null) {
        window.clearTimeout(chatLoadMoreRetryTimerRef.current);
      }
    },
    [],
  );
  const chatLoadMoreCursorKey = chatAutoLoadCursorKey(sessionPageCursor);

  const chatLoadMoreAttemptKey = `${chatLoadMoreCursorKey}#${chatLoadMoreAttempt}`;

  useEffect(() => {
    if (!enabled || !hasMoreSessions || isLoadingMoreSessions) {
      return;
    }
    if (attemptedChatLoadMoreCursorRef.current === chatLoadMoreAttemptKey) {
      return;
    }

    attemptedChatLoadMoreCursorRef.current = chatLoadMoreAttemptKey;
    void (async () => {
      await loadMoreSessions();
      // The store logs and swallows a failed page, so "nothing arrived" is the
      // only signal: the cursor did not move and there is still more to load.
      // Without a retry the sidebar would stay short for the rest of the run.
      const state = useChatSessionStore.getState();
      const landed = chatAutoLoadPageLanded({
        cursorKeyBefore: chatLoadMoreCursorKey,
        cursorKeyAfter: chatAutoLoadCursorKey(state.sessionPageCursor),
        hasMoreSessions: state.hasMoreActiveSessions,
      });
      if (landed) {
        setChatLoadMoreAttempt((current) => (current === 0 ? current : 0));
        return;
      }
      // Back off, and give up after a few tries: the effect re-runs as soon as
      // `isLoadingMoreSessions` flips back, so an unbounded retry would spin
      // against a host that keeps failing.
      const attempt = chatLoadMoreAttempt + 1;
      const retryInMs = chatAutoLoadRetryDelayMs(attempt);
      if (retryInMs === null) return;
      chatLoadMoreRetryTimerRef.current = window.setTimeout(() => {
        chatLoadMoreRetryTimerRef.current = null;
        setChatLoadMoreAttempt(attempt);
      }, retryInMs);
    })();
  }, [
    chatLoadMoreAttempt,
    chatLoadMoreAttemptKey,
    chatLoadMoreCursorKey,
    enabled,
    hasMoreSessions,
    isLoadingMoreSessions,
    loadMoreSessions,
  ]);
}
