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
import type { Message } from "@/shared/types/messages";

/**
 * Whether a Tauri call failed because the command is not in this build.
 *
 * The notification plugin's `onAction` registers a listener through the
 * `notification.registerListener` command, which a build that ships the plugin
 * without that permission — or without the plugin at all — answers with
 * "not allowed. Command not found". That is a fact about the build, not a
 * fault at runtime: the feature is simply unavailable here.
 *
 * Matched on the text because there is nothing else to match on. Tauri returns
 * these as plain strings from the IPC layer, with no code or class to key off.
 */
export function isMissingTauriCommandError(error: unknown): boolean {
  const message = (
    typeof error === "string" ? error : (error as Error | null)?.message
  )?.toLowerCase();
  return Boolean(message?.includes("command not found"));
}

/**
 * Said once per window, not once per mount.
 *
 * Both notification effects re-run on remount, and the app renders this hook
 * in more than one place, so an unguarded log repeats the same non-event
 * several times a launch — which is how it read as a fault in the first place.
 */
let loggedNotificationActionsUnavailable = false;

function reportNotificationActionsUnavailable(error: unknown): void {
  if (isMissingTauriCommandError(error)) {
    if (!loggedNotificationActionsUnavailable) {
      loggedNotificationActionsUnavailable = true;
      console.info(
        "Notification actions are unavailable in this build; completion notifications will still be shown.",
      );
    }
    return;
  }
  console.warn("Failed to subscribe to notification actions:", error);
}

/**
 * Every subscription in this hook is a nice-to-have: window focus tracking and
 * the notification action handler. Losing one degrades notifications;
 * none of them is worth an unhandled rejection at launch, which is all an
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
 * The invoke can reject — Windows toasts need a registered AppUserModelID,
 * which dev builds and some portable installs do not have — and a
 * fire-and-forget invoke turned every completed turn into an unhandled
 * rejection (one diagnostic event and one `berd.log` line each) while never
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

/** Test seam: the once-per-window latches would otherwise leak between cases. */
export function resetNotificationAvailabilityLogForTests(): void {
  loggedNotificationActionsUnavailable = false;
  warnedDesktopNotificationUnavailable = false;
}

function focusCurrentWindow(): void {
  import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
    const appWindow = getCurrentWindow();
    void appWindow.show().catch(() => {});
    void appWindow.unminimize().catch(() => {});
    void appWindow.setFocus().catch(() => {});
  });
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
 * Titles are agent-settable (`berdctl session rename`), so this text is not
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

function getChangedSessionIds<T>(
  current: Record<string, T | undefined>,
  previous: Record<string, T | undefined>,
): string[] {
  const ids = new Set([...Object.keys(current), ...Object.keys(previous)]);
  return Array.from(ids).filter(
    (sessionId) => !Object.is(current[sessionId], previous[sessionId]),
  );
}

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

  // Keep notification actions working where the plugin exposes them.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;

    let unlisten: (() => void) | null = null;
    let cancelled = false;
    import("@tauri-apps/plugin-notification")
      .then(({ onAction }) =>
        onAction((notification) => {
          // Bringing the window forward is the part that always works: the
          // host command currently drops `session_id`, so `extra` carries no
          // session to open and clicking a toast used to do nothing at all.
          // FOLLOW-UP (src-tauri/src/commands/notifications.rs): pass
          // `extra: { sessionId }` so the click can open the chat again.
          focusCurrentWindow();
          const sessionId =
            typeof notification.extra?.sessionId === "string"
              ? notification.extra.sessionId
              : undefined;
          if (!sessionId) return;
          navigateRef.current(sessionId);
        }),
      )
      .then((listener) => {
        if (cancelled) void listener.unregister();
        else unlisten = () => void listener.unregister();
      })
      // Without this the whole chain is an unhandled rejection on every launch
      // — twice, once per mount — for a capability the build never had.
      .catch(reportNotificationActionsUnavailable);
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
        const prefs = getNotificationPrefs();
        if (!prefs.enabled) return;

        for (const sessionId of getChangedSessionIds(
          sessionStateById,
          previousSessionStateById,
        )) {
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
