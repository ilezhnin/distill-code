import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  type ChatState,
  INITIAL_SESSION_CHAT_RUNTIME,
  INITIAL_TOKEN_STATE,
  type SessionChatRuntime,
} from "@/shared/types/chat";
import { useCompletionNotifications } from "./useCompletionNotifications";

const mocks = vi.hoisted(() => ({
  getNotificationPrefs: vi.fn(),
  showCompletionNotificationToast: vi.fn(),
}));

vi.mock("@/features/settings/lib/notificationPrefs", () => ({
  getNotificationPrefs: mocks.getNotificationPrefs,
}));

vi.mock("@/shared/notifications/CompletionNotificationToast", () => ({
  showCompletionNotificationToast: mocks.showCompletionNotificationToast,
}));

vi.mock("@/shared/notifications/notificationSounds", () => ({
  getNotificationSoundResource: () => null,
  playNotificationSound: () => {},
}));

vi.mock("@/shared/assistive-ux/runtime", () => ({
  recordAssistiveMomentAccepted: () => {},
  recordAssistiveMomentShown: () => {},
  shouldShowAssistiveMoment: () => false,
}));

function runtime(
  chatState: ChatState,
  overrides: Partial<SessionChatRuntime> = {},
): SessionChatRuntime {
  return {
    ...INITIAL_SESSION_CHAT_RUNTIME,
    tokenState: { ...INITIAL_TOKEN_STATE },
    chatState,
    ...overrides,
  };
}

function setRuntime(sessionId: string, next: SessionChatRuntime): void {
  useChatStore.setState((state) => ({
    sessionStateById: { ...state.sessionStateById, [sessionId]: next },
  }));
}

describe("useCompletionNotifications", () => {
  beforeEach(() => {
    mocks.getNotificationPrefs.mockReturnValue({
      enabled: true,
      inApp: true,
      desktop: false,
      inAppSound: "none",
      desktopSound: "none",
    });
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      activeSessionId: null,
      isViewingActiveSession: false,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("notifies when a chat the operator is not watching finishes its turn", () => {
    renderHook(() => useCompletionNotifications(() => {}));

    setRuntime("s1", runtime("streaming"));
    setRuntime("s1", runtime("idle"));

    expect(mocks.showCompletionNotificationToast).toHaveBeenCalledTimes(1);
  });

  it("does not read preferences for runtime writes that leave every chat state alone", () => {
    renderHook(() => useCompletionNotifications(() => {}));
    setRuntime("s1", runtime("streaming"));
    const readsWhileStarting = mocks.getNotificationPrefs.mock.calls.length;

    for (let sample = 1; sample <= 5; sample += 1) {
      setRuntime(
        "s1",
        runtime("streaming", {
          tokenState: { ...INITIAL_TOKEN_STATE, accumulatedTotal: sample },
        }),
      );
    }

    expect(mocks.getNotificationPrefs).toHaveBeenCalledTimes(
      readsWhileStarting,
    );
    expect(mocks.showCompletionNotificationToast).not.toHaveBeenCalled();
  });

  it("still notifies for a chat that was working before it mounted and paused for permission", () => {
    setRuntime("s1", runtime("streaming"));
    renderHook(() => useCompletionNotifications(() => {}));

    // The first runtime write the hook sees marks the working chat pending,
    // which is what lets the idle after a permission pause notify.
    setRuntime(
      "s1",
      runtime("streaming", {
        tokenState: { ...INITIAL_TOKEN_STATE, accumulatedTotal: 1 },
      }),
    );
    setRuntime("s1", runtime("waiting"));
    setRuntime("s1", runtime("idle"));

    expect(mocks.showCompletionNotificationToast).toHaveBeenCalledTimes(1);
  });

  it("forgets a pending chat whose runtime was removed", () => {
    renderHook(() => useCompletionNotifications(() => {}));
    setRuntime("s1", runtime("streaming"));
    useChatStore.setState({ sessionStateById: {} });

    setRuntime("s1", runtime("waiting"));
    setRuntime("s1", runtime("idle"));

    expect(mocks.showCompletionNotificationToast).not.toHaveBeenCalled();
  });
});
