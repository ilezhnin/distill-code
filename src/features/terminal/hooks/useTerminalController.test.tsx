import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TERMINAL_STORAGE_KEY_PREFIX } from "../model/terminalState";
import { useTerminalController } from "./useTerminalController";

vi.mock("sonner", () => ({
  toast: { message: vi.fn() },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../lib/terminalSessionManager", () => ({
  queueTerminalCommand: vi.fn(),
  restartTerminalSession: vi.fn(),
  runCommandInTerminalSession: vi.fn(() => true),
  stopTerminalSession: vi.fn(),
  subscribeTerminalSessionStatus: vi.fn(() => () => undefined),
}));

describe("useTerminalController", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps the draft's tabs when the chat is promoted and drops the draft key", () => {
    const { result, rerender } = renderHook(
      ({ sessionId }) => useTerminalController({ sessionId, cwd: "/repo" }),
      { initialProps: { sessionId: "draft-1" } },
    );

    act(() => {
      result.current.toggle();
    });
    expect(result.current.tabs).toHaveLength(1);
    const tabId = result.current.tabs[0]?.id;
    expect(
      window.localStorage.getItem(`${TERMINAL_STORAGE_KEY_PREFIX}:draft-1`),
    ).toContain(tabId);

    rerender({ sessionId: "backend-1" });

    expect(result.current.tabs.map((tab) => tab.id)).toEqual([tabId]);
    expect(
      window.localStorage.getItem(`${TERMINAL_STORAGE_KEY_PREFIX}:backend-1`),
    ).toContain(tabId);
    expect(
      window.localStorage.getItem(`${TERMINAL_STORAGE_KEY_PREFIX}:draft-1`),
    ).toBeNull();
  });
});
