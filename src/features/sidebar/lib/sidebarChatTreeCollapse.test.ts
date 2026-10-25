import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SIDEBAR_COLLAPSED_CHAT_TREES_STORAGE_KEY,
  expandChatTrees,
  isChatTreeCollapsed,
  resetCollapsedChatTreesForTests,
  setChatTreeCollapsed,
  useCollapsedChatTrees,
} from "./sidebarChatTreeCollapse";

beforeEach(() => {
  window.localStorage.removeItem(SIDEBAR_COLLAPSED_CHAT_TREES_STORAGE_KEY);
  resetCollapsedChatTreesForTests();
});

afterEach(() => {
  window.localStorage.removeItem(SIDEBAR_COLLAPSED_CHAT_TREES_STORAGE_KEY);
  resetCollapsedChatTreesForTests();
});

describe("sidebar chat tree folds", () => {
  it("starts unfolded, folds per chat, and tells subscribers", () => {
    const { result } = renderHook(() => useCollapsedChatTrees());
    expect(result.current.size).toBe(0);
    act(() => setChatTreeCollapsed("chat-a", true));
    expect(result.current.has("chat-a")).toBe(true);
    expect(isChatTreeCollapsed("chat-a")).toBe(true);
    act(() => setChatTreeCollapsed("chat-a", false));
    expect(result.current.has("chat-a")).toBe(false);
  });

  it("remembers folds across a reload", () => {
    setChatTreeCollapsed("chat-a", true);
    setChatTreeCollapsed("chat-b", true);
    resetCollapsedChatTreesForTests();
    expect(isChatTreeCollapsed("chat-a")).toBe(true);
    expect(isChatTreeCollapsed("chat-b")).toBe(true);
    expect(
      JSON.parse(
        window.localStorage.getItem(SIDEBAR_COLLAPSED_CHAT_TREES_STORAGE_KEY) ??
          "[]",
      ),
    ).toEqual(["chat-a", "chat-b"]);
  });

  it("unfolds the chats an operator opens into, leaving other folds alone", () => {
    setChatTreeCollapsed("chat-a", true);
    setChatTreeCollapsed("chat-b", true);
    expandChatTrees(["chat-a", "never-folded"]);
    expect(isChatTreeCollapsed("chat-a")).toBe(false);
    expect(isChatTreeCollapsed("chat-b")).toBe(true);
  });

  it("ignores a stored value that is not a list of ids", () => {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSED_CHAT_TREES_STORAGE_KEY,
      JSON.stringify({ "chat-a": true }),
    );
    expect(isChatTreeCollapsed("chat-a")).toBe(false);
    window.localStorage.setItem(
      SIDEBAR_COLLAPSED_CHAT_TREES_STORAGE_KEY,
      "not json",
    );
    resetCollapsedChatTreesForTests();
    expect(isChatTreeCollapsed("chat-a")).toBe(false);
  });

  it("forgets the oldest folds past the cap", () => {
    for (let index = 0; index < 201; index += 1) {
      setChatTreeCollapsed(`chat-${index}`, true);
    }
    expect(isChatTreeCollapsed("chat-0")).toBe(false);
    expect(isChatTreeCollapsed("chat-1")).toBe(true);
    expect(isChatTreeCollapsed("chat-200")).toBe(true);
  });
});
