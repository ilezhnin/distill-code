import { describe, expect, it } from "vitest";
import {
  CHAT_AUTO_LOAD_RETRY_BASE_MS,
  chatAutoLoadCursorKey,
  chatAutoLoadPageLanded,
  chatAutoLoadRetryDelayMs,
  MAX_CHAT_AUTO_LOAD_RETRIES,
} from "./sidebarChatAutoLoad";

describe("sidebar chat auto-load", () => {
  it("keys the first page and later cursors apart", () => {
    expect(chatAutoLoadCursorKey(null)).toBe("__initial__");
    expect(chatAutoLoadCursorKey("cursor-2")).toBe("cursor-2");
  });

  it("counts an advanced cursor or an exhausted list as a landed page", () => {
    expect(
      chatAutoLoadPageLanded({
        cursorKeyBefore: "cursor-1",
        cursorKeyAfter: "cursor-2",
        hasMoreSessions: true,
      }),
    ).toBe(true);
    expect(
      chatAutoLoadPageLanded({
        cursorKeyBefore: "cursor-1",
        cursorKeyAfter: "cursor-1",
        hasMoreSessions: false,
      }),
    ).toBe(true);
  });

  it("counts an unchanged cursor with more to load as a failed page", () => {
    expect(
      chatAutoLoadPageLanded({
        cursorKeyBefore: "__initial__",
        cursorKeyAfter: "__initial__",
        hasMoreSessions: true,
      }),
    ).toBe(false);
  });

  it("backs off between retries and then gives up", () => {
    expect(chatAutoLoadRetryDelayMs(1)).toBe(CHAT_AUTO_LOAD_RETRY_BASE_MS);
    expect(chatAutoLoadRetryDelayMs(2)).toBe(CHAT_AUTO_LOAD_RETRY_BASE_MS * 2);
    expect(
      chatAutoLoadRetryDelayMs(MAX_CHAT_AUTO_LOAD_RETRIES),
    ).toBeGreaterThan(CHAT_AUTO_LOAD_RETRY_BASE_MS);
    expect(chatAutoLoadRetryDelayMs(MAX_CHAT_AUTO_LOAD_RETRIES + 1)).toBeNull();
    expect(chatAutoLoadRetryDelayMs(0)).toBeNull();
  });
});
