import { useEffect, useRef } from "react";
import {
  isSessionActivelyViewed,
  useChatStore,
} from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { getNotificationPrefs } from "@/features/settings/lib/notificationPrefs";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import { isDefaultChatTitle } from "@/features/chat/lib/sessionTitle";
import { showCompletionNotificationToast } from "@/shared/notifications/CompletionNotificationToast";
import {
  getNotificationSoundResource,
  playNotificationSound,
} from "@/shared/notifications/notificationSounds";
import { ASSISTIVE_UX_RULES } from "@/shared/assistive-ux/registry";
import { i18n } from "@/shared/i18n";
import {
  recordAssistiveMomentAccepted,
  recordAssistiveMomentShown,
  shouldShowAssistiveMoment,
} from "@/shared/assistive-ux/runtime";
import type { SessionChatRuntime } from "@/shared/types/chat";
import type { Message } from "@/shared/types/messages";

/**
 * Window focus tracking is a nice-to-have: losing it degrades notifications,
 * and that is not worth an unhandled rejection at launch, which is all an
 * un-caught `import(...).then(...)` chain can produce.
 */
function reportSubscriptionFailed(what: string) {
  return (error: unknown): void => {
    console.warn(`Failed to subscribe to ${what}:`, error);
  };
}

let warnedDesktopNotificationUnavailable = false;

/**
 * Shows the OS notification for a finished turn.
 *
 * The click is the host's: the toast carries `sessionId`, and a click on it
 * opens that chat the way a `flock://session/<id>` link does, then brings
 * the window forward (`src-tauri/src/commands/notifications.rs`). Nothing in
 * the renderer can hear that click: the notification plugin registers no
 * action listener on desktop.
 *
 * The invoke can reject — Windows toasts need a registered AppUserModelID,
 * which dev builds and some portable installs do not have — and a
 * fire-and-forget invoke turned every completed turn into an unhandled
 * rejection (one diagnostic event and one `flock.log` line each) while never
 * telling anyone why notifications were silent. Said once per window.
 */
export async function showDesktopCompletionNotification(args: {
  body: string;
  sessionId: string;
  sound: string | null;
}): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("show_completion_notification", args);
  } catch (error) {
    if (warnedDesktopNotificationUnavailable) return;
    warnedDesktopNotificationUnavailable = true;
    console.warn(
      "Desktop completion notifications are unavailable in this build:",
      error,
    );
  }
}

/** Test seam: the once-per-window latch would otherwise leak between cases. */
export function resetNotificationAvailabilityLogForTests(): void {
  warnedDesktopNotificationUnavailable = false;
}

export function getCompletionOutcome(
  messages: Message[],
): "completed" | "error" | "stopped" {
  for (let i = messages.length - 1; i >= 0; i--) {
    const status = messages[i].metadata?.completionStatus;
    if (status === "error") return "error";
    if (status === "stopped") return "stopped";
    if (status === "completed") return "completed";
  }
  return "completed";
}

/** How much of a chat title the OS notification body may carry. */
const MAX_NOTIFICATION_NAME_CHARS = 80;

/**
 * A chat title, fit for an OS notification body.
 *
 * Titles are agent-settable (`flockctl session rename`), so this text is not
 * ours: collapse the control characters a title could use to fake extra lines,
 * and cap the length so the fixed "… finished" suffix is not pushed out of
 * view by a long one.
 */
export function clampNotificationName(sessionTitle: string): string {
  const flattened = sessionTitle
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(flattened);
  if (characters.length <= MAX_NOTIFICATION_NAME_CHARS) return flattened;
  return `${characters
    .slice(0, MAX_NOTIFICATION_NAME_CHARS - 1)
    .join("")
    .trimEnd()}\u2026`;
}

export function getNotificationBody(
  outcome: "completed" | "error" | "stopped",
  sessionTitle: string,
): string {
  const name =
    clampNotificationName(sessionTitle) ||
    i18n.t("common:completionNotification.agent");
  return i18n.t(`common:completionNotification.body.${outcome}`, { name });
}

/**
 * The sessions a runtime change can matter to: those whose chat state moved,
 * whose runtime went away, or that are working and not yet tracked as pending.
 *
 * Runtimes are replaced for much more than chat state (token usage, the
 * streaming message, run ids), several times a second while any chat streams.
 * Answering "nothing relevant" here, without collecting every id, spares each
 * of those writes the id arrays and the preferences read that follow.
 */
function getSessionsWithChatStateChanges(
  current: Record<string, SessionChatRuntime | undefined>,
  previous: Record<string, SessionChatRuntime | undefined>,
  pendingSessions: ReadonlySet<string>,
): string[] {
  const changed: string[] = [];
  for (const sessionId in current) {
    const curr = current[sessionId];
    const prev = previous[sessionId];
    if (curr === prev) continue;
    if (
      !curr ||
      curr.chatState !== prev?.chatState ||
      ((curr.chatState === "streaming" || curr.chatState === "thinking") &&
        !pendingSessions.has(sessionId))
    ) {
      changed.push(sessionId);
    }
  }
  for (const sessionId in previous) {
    if (previous[sessionId] && !Object.hasOwn(current, sessionId)) {
      changed.push(sessionId);
    }
  }
  return changed;
}

/**
 * Raises the in-app toast or the OS notification when a chat the operator is
 * not watching finishes its turn. `onNavigateToSession` serves the in-app
 * toast's View button; the OS toast's click is handled by the host, which
 * opens the chat through the same path (see
 * {@link showDesktopCompletionNotification}).
 */
export function useCompletionNotifications(
  onNavigateToSession: (sessionId: string) => void,
): void {
  const windowFocusedRef = useRef(true);
  // Keep a stable ref so the Zustand subscriber never has a stale callback.
  const navigateRef = useRef(onNavigateToSession);
  useEffect(() => {
    navigateRef.current = onNavigateToSession;
  }, [onNavigateToSession]);

  // Track window focus via Tauri's native API.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().onFocusChanged(({ payload: focused }) => {
          windowFocusedRef.current = focused;
        }),
      )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(reportSubscriptionFailed("window focus changes"));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Subscribe to runtime-state changes only. Streaming text writes update the
  // message array, so they should not make notification handling scan sessions.
  // Refs are stable so the dep array is [].
  useEffect(() => {
    const pendingSessions = new Set<string>();
    return useChatStore.subscribe(
      (state) => state.sessionStateById,
      (sessionStateById, previousSessionStateById) => {
        const changedSessionIds = getSessionsWithChatStateChanges(
          sessionStateById,
          previousSessionStateById,
          pendingSessions,
        );
        if (changedSessionIds.length === 0) return;

        const prefs = getNotificationPrefs();
        if (!prefs.enabled) return;

        for (const sessionId of changedSessionIds) {
          const curr = sessionStateById[sessionId]?.chatState;
          const prev = previousSessionStateById[sessionId]?.chatState;
          if (!curr) {
            pendingSessions.delete(sessionId);
            continue;
          }

          // Track when a session enters an active state.
          if (curr === "streaming" || curr === "thinking") {
            pendingSessions.add(sessionId);
          }

          // Fire when a pending session reaches idle.
          if (
            curr === "idle" &&
            prev !== "idle" &&
            (pendingSessions.has(sessionId) ||
              prev === "streaming" ||
              prev === "thinking")
          ) {
            pendingSessions.delete(sessionId);

            const chatStoreState = useChatStore.getState();
            const isViewingThisSession = isSessionActivelyViewed(
              chatStoreState,
              sessionId,
            );
            // Skip if user is already watching this session in a focused window.
            if (isViewingThisSession && windowFocusedRef.current) continue;

            const messages = chatStoreState.messagesBySession[sessionId] ?? [];
            const outcome = getCompletionOutcome(messages);
            const session = useChatSessionStore
              .getState()
              .getSession(sessionId);
            // Use the session title only when it's user-set; fall back to empty
            // string so getNotificationBody uses the "Agent" default.
            const title =
              session && !isDefaultChatTitle(session.title)
                ? session.title
                : "";
            const body = getNotificationBody(outcome, title);

            if (!windowFocusedRef.current) {
              if (!prefs.desktop) continue;
              void showDesktopCompletionNotification({
                body,
                sessionId,
                sound: getNotificationSoundResource(prefs.desktopSound) ?? null,
              });
            } else {
              if (!prefs.inApp) continue;
              playNotificationSound(prefs.inAppSound);
              const shouldShowChangeSound = shouldShowAssistiveMoment(
                ASSISTIVE_UX_RULES.notificationsChangeSound.id,
              );
              if (shouldShowChangeSound) {
                recordAssistiveMomentShown(
                  ASSISTIVE_UX_RULES.notificationsChangeSound.id,
                );
              }
              showCompletionNotificationToast({
                title: body,
                outcome,
                onView: () => navigateRef.current(sessionId),
                onChangeSound: shouldShowChangeSound
                  ? () => {
                      recordAssistiveMomentAccepted(
                        ASSISTIVE_UX_RULES.notificationsChangeSound.id,
                      );
                      requestOpenSettings("notifications");
                    }
                  : undefined,
              });
            }
          }
        }
      },
    );
  }, []);
}
