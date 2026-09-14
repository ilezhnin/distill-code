import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useBulkSessionActions } from "../useBulkSessionActions";

const mocks = vi.hoisted(() => ({
  sessionIdsWithTerminals: new Set<string>(),
  applySessionActionToIds: vi.fn(
    async (_sessionIds: Set<string>, _action?: unknown) => ({
      failedCount: 0,
    }),
  ),
}));

vi.mock("@/features/terminal/lib/terminalSessionManager", () => ({
  getChatSessionIdsWithTerminals: () => mocks.sessionIdsWithTerminals,
}));

vi.mock("../../lib/sessionSelection", () => ({
  applySessionActionToIds: (sessionIds: Set<string>, action?: unknown) =>
    mocks.applySessionActionToIds(sessionIds, action),
}));

function renderBulkActions(selected: string[]) {
  return renderHook(() =>
    useBulkSessionActions({
      selectedSessionIds: new Set(selected),
      onComplete: () => {},
      onFailure: () => {},
    }),
  );
}

describe("useBulkSessionActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionIdsWithTerminals.clear();
    mocks.applySessionActionToIds.mockResolvedValue({ failedCount: 0 });
  });

  it("counts the shells the archive is about to stop", () => {
    // The confirmation used to promise "you can restore it in Settings" while
    // the archive silently killed the chat's dev server, which unarchive does
    // not bring back. The count is what lets the dialog say so.
    mocks.sessionIdsWithTerminals.add("session-1");
    mocks.sessionIdsWithTerminals.add("session-3");
    const { result } = renderBulkActions(["session-1", "session-2"]);

    act(() => {
      result.current.requestArchiveSelected();
    });

    expect(result.current.archiveConfirmOpen).toBe(true);
    expect(result.current.archiveSelectionCount).toBe(2);
    // Only the selected chat's shells count; session-3 was not selected.
    expect(result.current.archiveTerminalCount).toBe(1);
  });

  it("is zero when nothing selected has a live shell", () => {
    mocks.sessionIdsWithTerminals.add("other");
    const { result } = renderBulkActions(["session-1"]);

    act(() => {
      result.current.requestArchiveSelected();
    });

    expect(result.current.archiveTerminalCount).toBe(0);
  });

  it("forgets the count once the archive is confirmed", async () => {
    const archive = vi.fn();
    mocks.sessionIdsWithTerminals.add("session-1");
    const { result } = renderBulkActions(["session-1"]);
    act(() => {
      result.current.requestArchiveSelected();
    });

    await act(async () => {
      await result.current.confirmArchiveSelected(archive);
    });

    expect(result.current.archiveTerminalCount).toBe(0);
    expect(mocks.applySessionActionToIds).toHaveBeenCalledWith(
      new Set(["session-1"]),
      archive,
    );
  });
});
