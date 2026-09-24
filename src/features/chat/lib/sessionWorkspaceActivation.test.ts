import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyPendingSessionWorkspaceActivation,
  claimSessionWorkspaceIntent,
  clearPendingSessionWorkspaceActivation,
  getPendingSessionWorkspaceActivation,
  queueSessionWorkspaceActivation,
} from "./sessionWorkspaceActivation";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";

const mocks = vi.hoisted(() => ({
  checkDirectoriesExist: vi.fn(),
  getGitState: vi.fn(),
  updateWorkingDir: vi.fn(),
}));

vi.mock("@/shared/api/pathResolver", () => ({
  checkDirectoriesExist: (...args: unknown[]) =>
    mocks.checkDirectoriesExist(...args),
}));
vi.mock("@/shared/api/git", () => ({
  getGitState: (...args: unknown[]) => mocks.getGitState(...args),
}));
vi.mock("@/shared/api/acpApi", () => ({
  archiveSession: vi.fn(),
  unarchiveSession: vi.fn(),
  updateWorkingDir: (
    sessionId: string,
    path: string,
    beforeUpdate?: () => void,
  ) => {
    beforeUpdate?.();
    return mocks.updateWorkingDir(sessionId, path);
  },
}));

function session(): ChatSession {
  return {
    id: "session-1",
    title: "Chat",
    workingDir: "/tmp/main",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
  };
}

describe("session workspace activation", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearPendingSessionWorkspaceActivation("session-1");
    vi.clearAllMocks();
    useChatSessionStore.setState({
      sessions: [session()],
      activeWorkspaceBySession: {},
    });
    useChatStore.setState({
      sessionStateById: {},
    });
    mocks.checkDirectoriesExist.mockResolvedValue([]);
    mocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "feature",
    });
    mocks.updateWorkingDir.mockResolvedValue(undefined);
  });

  it("shares one commit when the idle drain and next prompt race", async () => {
    queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/tmp/feature",
      branch: "feature",
    });
    let releaseUpdate: (() => void) | undefined;
    mocks.updateWorkingDir.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseUpdate = resolve;
        }),
    );

    const idleDrain = applyPendingSessionWorkspaceActivation("session-1");
    const promptBarrier = applyPendingSessionWorkspaceActivation("session-1");

    expect(idleDrain).toBe(promptBarrier);
    await vi.waitFor(() => {
      expect(mocks.updateWorkingDir).toHaveBeenCalledTimes(1);
      expect(releaseUpdate).toBeTypeOf("function");
    });
    releaseUpdate?.();
    await expect(promptBarrier).resolves.toBe("/tmp/feature");
  });

  it("applies a newer request before releasing an in-flight barrier", async () => {
    queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/tmp/one",
      branch: "one",
    });
    let releaseFirst: (() => void) | undefined;
    mocks.updateWorkingDir
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const barrier = applyPendingSessionWorkspaceActivation("session-1");
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/tmp/two",
      branch: "two",
    });
    releaseFirst?.();

    await expect(barrier).resolves.toBe("/tmp/two");
    expect(mocks.updateWorkingDir.mock.calls).toEqual([
      ["session-1", "/tmp/one"],
      ["session-1", "/tmp/two"],
    ]);
    expect(
      useChatSessionStore.getState().getSession("session-1")?.workingDir,
    ).toBe("/tmp/two");
  });

  it("keeps the switch pending if the session starts before dispatch", async () => {
    queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/tmp/feature",
      branch: "feature",
    });
    mocks.updateWorkingDir.mockImplementationOnce(async () => {
      useChatStore.getState().setChatState("session-1", "streaming");
      throw new Error(
        "The session started running before its pending workspace switch could be applied.",
      );
    });

    await expect(
      applyPendingSessionWorkspaceActivation("session-1"),
    ).rejects.toThrow("started running");
    expect(getPendingSessionWorkspaceActivation("session-1")).toMatchObject({
      path: "/tmp/feature",
    });
    expect(
      useChatSessionStore.getState().getSession("session-1")?.workingDir,
    ).toBe("/tmp/main");
  });

  it("keeps a transiently failed activation pending", async () => {
    queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/tmp/feature",
      branch: "feature",
    });
    mocks.updateWorkingDir.mockRejectedValueOnce(new Error("backend offline"));

    await expect(
      applyPendingSessionWorkspaceActivation("session-1"),
    ).rejects.toThrow("backend offline");

    expect(getPendingSessionWorkspaceActivation("session-1")).toMatchObject({
      path: "/tmp/feature",
    });
    expect(
      useChatSessionStore.getState().getSession("session-1")?.workingDir,
    ).toBe("/tmp/main");
  });
  it("rejects an older lifecycle intent after a newer cwd intent is claimed", () => {
    const staleGeneration = claimSessionWorkspaceIntent("session-1");
    claimSessionWorkspaceIntent("session-1");

    expect(() =>
      queueSessionWorkspaceActivation({
        sessionId: "session-1",
        path: "/tmp/stale",
        branch: null,
        intentGeneration: staleGeneration,
      }),
    ).toThrow("newer session workspace intent");
    expect(getPendingSessionWorkspaceActivation("session-1")).toBeNull();
  });
});
