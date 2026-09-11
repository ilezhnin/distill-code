import { useEffect } from "react";

import {
  applyPendingSessionWorkspaceActivation,
  listPendingSessionWorkspaceActivations,
  subscribeToPendingSessionWorkspaceActivations,
} from "@/features/chat/lib/sessionWorkspaceActivation";
import {
  isSessionRuntimeSettled,
  useChatStore,
} from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { createSystemNotificationMessage } from "@/shared/types/messages";

const drainingSessionIds = new Set<string>();
const reportedFailureRequestIds = new Set<string>();

function drainReadyActivations(): void {
  for (const activation of listPendingSessionWorkspaceActivations()) {
    if (drainingSessionIds.has(activation.sessionId)) continue;
    if (!useChatSessionStore.getState().getSession(activation.sessionId)) {
      continue;
    }
    const runtime = useChatStore
      .getState()
      .getSessionRuntime(activation.sessionId);
    if (!isSessionRuntimeSettled(runtime)) continue;

    drainingSessionIds.add(activation.sessionId);
    void applyPendingSessionWorkspaceActivation(activation.sessionId)
      .catch((error) => {
        console.error(
          `[workspace-activation] failed for session ${activation.sessionId}`,
          error,
        );
        if (!reportedFailureRequestIds.has(activation.requestId)) {
          reportedFailureRequestIds.add(activation.requestId);
          const stillPending = listPendingSessionWorkspaceActivations().some(
            (pending) => pending.requestId === activation.requestId,
          );
          const message = stillPending
            ? `Couldn’t switch this chat to ${activation.path}. The switch will be retried before the next prompt. ${String(error)}`
            : `Couldn’t switch this chat to ${activation.path}. The pending switch was canceled. ${String(error)}`;
          const chatStore = useChatStore.getState();
          chatStore.addMessage(
            activation.sessionId,
            createSystemNotificationMessage(message, "error"),
          );
          chatStore.setError(activation.sessionId, message);
        }
      })
      .finally(() => {
        drainingSessionIds.delete(activation.sessionId);
        const latest = listPendingSessionWorkspaceActivations().find(
          (pending) => pending.sessionId === activation.sessionId,
        );
        if (latest && latest.requestId !== activation.requestId) {
          drainReadyActivations();
        }
      });
  }
}

/** Applies persisted workspace switches as soon as their sessions settle. */
export function usePendingSessionWorkspaceActivationDrain(): void {
  useEffect(() => {
    const drain = () => drainReadyActivations();
    drain();
    const unsubscribePending =
      subscribeToPendingSessionWorkspaceActivations(drain);
    const unsubscribeChat = useChatStore.subscribe((state, previousState) => {
      if (state.sessionStateById !== previousState.sessionStateById) {
        drain();
      }
    });
    const unsubscribeSessions = useChatSessionStore.subscribe(
      (state, previousState) => {
        if (
          state.hasHydratedSessions !== previousState.hasHydratedSessions ||
          state.sessions !== previousState.sessions
        ) {
          drain();
        }
      },
    );
    return () => {
      unsubscribePending();
      unsubscribeChat();
      unsubscribeSessions();
    };
  }, []);
}
