import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useSessionListRefresh } from "../useSessionListRefresh";

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
}

describe("useSessionListRefresh", () => {
  const loadSessions = vi.fn(async () => {});
  let originalLoadSessions: () => Promise<void>;

  beforeEach(() => {
    vi.useFakeTimers();
    loadSessions.mockClear();
    originalLoadSessions = useChatSessionStore.getState().loadSessions;
    useChatSessionStore.setState({ loadSessions });
  });

  afterEach(() => {
    useChatSessionStore.setState({ loadSessions: originalLoadSessions });
    // The own property shadows jsdom's getter on the prototype; dropping it
    // restores the real value for the next test.
    Reflect.deleteProperty(document, "hidden");
    vi.useRealTimers();
  });

  it("refreshes on each interval tick while the window is visible", () => {
    setDocumentHidden(false);
    const { unmount } = renderHook(() => useSessionListRefresh());

    vi.advanceTimersByTime(60_000);
    expect(loadSessions).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(loadSessions).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("skips interval ticks while the window is hidden but still refreshes on focus", () => {
    setDocumentHidden(true);
    const { unmount } = renderHook(() => useSessionListRefresh());

    vi.advanceTimersByTime(5 * 60_000);
    expect(loadSessions).not.toHaveBeenCalled();

    setDocumentHidden(false);
    window.dispatchEvent(new Event("focus"));
    expect(loadSessions).toHaveBeenCalledTimes(1);
    unmount();
  });
});
