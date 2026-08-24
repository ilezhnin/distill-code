import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/features/chat/stores/chatStore";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { setAutoArchiveAfter } from "@/features/settings/lib/autoArchivePreference";
import { runAutoArchiveSweep } from "../useAutoArchiveSessions";

const mocks = vi.hoisted(() => ({
  getSessionInfo: vi.fn(),
  loadAllSessions: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpGetSessionInfo: (...args: unknown[]) => mocks.getSessionInfo(...args),
}));

vi.mock("@/features/chat/lib/sessionWorkspaceCleanup", () => ({
  loadAllSessionsForWorkspaceCleanup: (...args: unknown[]) =>
    mocks.loadAllSessions(...args),
}));

function session(id: string, updatedAt = "2026-01-01T00:00:00.000Z") {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    lastMessageAt: updatedAt,
    messageCount: 1,
  } satisfies ChatSession;
}

function resetStores() {
  useChatSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    archiveMutationBySessionId: {},
  });
  useChatStore.setState({
    queuedMessageBySession: {},
    draftsBySession: {},
    nonEmptyDraftSessionIds: new Set(),
    skillDraftsBySession: {},
    draftAttachmentsBySession: {},
    hasHydratedMessageQueues: true,
  });
  useSessionWindowStore.getState().setSnapshot([]);
}

describe("runAutoArchiveSweep", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    setAutoArchiveAfter("7-days");
    mocks.getSessionInfo
      .mockReset()
      .mockImplementation((sessionId: string) => ({
        sessionId,
        title: sessionId,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastMessageAt: "2026-01-01T00:00:00.000Z",
        archivedAt: null,
        messageCount: 1,
        userSetName: false,
      }));
    mocks.loadAllSessions.mockReset();
  });

  it("does nothing while disabled", async () => {
    setAutoArchiveAfter("never");
    const archiveSession = vi.fn();

    await runAutoArchiveSweep({ archiveSession });

    expect(mocks.loadAllSessions).not.toHaveBeenCalled();
    expect(archiveSession).not.toHaveBeenCalled();
  });

  it("waits for persisted message queues to hydrate", async () => {
    const stale = session("stale");
    mocks.loadAllSessions.mockResolvedValue([stale]);
    useChatStore.setState({ hasHydratedMessageQueues: false });
    const archiveSession = vi.fn();

    await runAutoArchiveSweep({ archiveSession });

    expect(archiveSession).not.toHaveBeenCalled();
  });

  it("waits for the detached-window snapshot to hydrate", async () => {
    const stale = session("stale");
    mocks.loadAllSessions.mockResolvedValue([stale]);
    useSessionWindowStore.setState({ hasLoadedSnapshot: false });
    const archiveSession = vi.fn();

    await runAutoArchiveSweep({ archiveSession });

    expect(archiveSession).not.toHaveBeenCalled();
  });

  it("skips sessions with a pending archive-state mutation", async () => {
    const stale = session("stale");
    mocks.loadAllSessions.mockResolvedValue([stale]);
    useChatSessionStore.setState({
      sessions: [stale],
      archiveMutationBySessionId: {
        stale: {
          operationId: 1,
          desiredState: "unarchived",
          status: "pending",
        },
      },
    });
    const archiveSession = vi.fn();

    await runAutoArchiveSweep({ archiveSession });

    expect(archiveSession).not.toHaveBeenCalled();
  });

  it("stops before later mutations when the user disables the setting", async () => {
    const first = session("first");
    const second = session("second");
    mocks.loadAllSessions.mockResolvedValue([first, second]);
    const archiveSession = vi.fn(async (candidate: ChatSession) => {
      if (candidate.id === "first") setAutoArchiveAfter("never");
      return { ok: true };
    });

    await runAutoArchiveSweep({ archiveSession });

    expect(archiveSession).toHaveBeenCalledTimes(1);
    expect(archiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "first" }),
      expect.any(Function),
    );
  });

  it("continues after one candidate fails revalidation", async () => {
    const first = session("first");
    const second = session("second");
    mocks.loadAllSessions.mockResolvedValue([first, second]);
    mocks.getSessionInfo
      .mockRejectedValueOnce(new Error("session disappeared"))
      .mockImplementation((sessionId: string) => ({
        sessionId,
        title: sessionId,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastMessageAt: "2026-01-01T00:00:00.000Z",
        archivedAt: null,
        messageCount: 1,
        userSetName: false,
      }));
    const archiveSession = vi.fn().mockResolvedValue({ ok: true });

    await runAutoArchiveSweep({ archiveSession });

    expect(archiveSession).toHaveBeenCalledTimes(1);
    expect(archiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "second" }),
      expect.any(Function),
    );
  });

  it("provides a final guard for changes while the archive transaction waits", async () => {
    const stale = session("stale");
    mocks.loadAllSessions.mockResolvedValue([stale]);
    const archiveSession = vi.fn(
      async (_candidate: ChatSession, revalidate: () => Promise<boolean>) => {
        useChatSessionStore.setState({ activeSessionId: "stale" });
        expect(await revalidate()).toBe(false);
        return { ok: false };
      },
    );

    await runAutoArchiveSweep({ archiveSession });

    expect(archiveSession).toHaveBeenCalledTimes(1);
  });

  it("skips a candidate with newer local activity than the refreshed backend row", async () => {
    const stale = session("stale");
    mocks.loadAllSessions.mockResolvedValue([stale]);
    useChatSessionStore.setState({
      sessions: [
        session("stale", new Date(Date.now() - 60 * 60 * 1000).toISOString()),
      ],
    });
    const archiveSession = vi.fn();

    await runAutoArchiveSweep({ archiveSession });

    expect(archiveSession).not.toHaveBeenCalled();
  });

  it("skips a later candidate that becomes active", async () => {
    const first = session("first");
    const second = session("second");
    mocks.loadAllSessions.mockResolvedValue([first, second]);
    const archiveSession = vi.fn(async (candidate: ChatSession) => {
      if (candidate.id === "first") {
        useChatSessionStore.setState({ activeSessionId: "second" });
      }
      return { ok: true };
    });

    await runAutoArchiveSweep({ archiveSession });

    expect(archiveSession).toHaveBeenCalledTimes(1);
    expect(archiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "first" }),
      expect.any(Function),
    );
  });

  it.each([
    [
      "a running session",
      () => {
        useChatStore.getState().setChatState("stale", "streaming");
        return {};
      },
    ],
    [
      "a detached window",
      () => {
        useSessionWindowStore
          .getState()
          .setSnapshot([{ sessionId: "stale", windowLabel: "session:stale" }]);
        return {};
      },
    ],
    ["composer text", () => ({ nonEmptyDraftSessionIds: new Set(["stale"]) })],
    [
      "queued message",
      () => ({
        queuedMessageBySession: { stale: [{}] },
      }),
    ],
    ["skill draft", () => ({ skillDraftsBySession: { stale: [{}] } })],
    [
      "draft attachment",
      () => ({ draftAttachmentsBySession: { stale: [{}] } }),
    ],
  ])("preserves %s", async (_label, unsafeState) => {
    const stale = session("stale");
    mocks.loadAllSessions.mockResolvedValue([stale]);
    useChatStore.setState(unsafeState() as never);
    const archiveSession = vi.fn();

    await runAutoArchiveSweep({ archiveSession });

    expect(archiveSession).not.toHaveBeenCalled();
  });
});
