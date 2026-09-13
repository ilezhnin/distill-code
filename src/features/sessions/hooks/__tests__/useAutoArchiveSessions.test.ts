import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/features/chat/stores/chatStore";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { setAutoArchiveAfter } from "@/features/settings/lib/autoArchivePreference";
import {
  runAutoArchiveSweep,
  shouldSweepOnVisibility,
  useAutoArchiveSessions,
} from "../useAutoArchiveSessions";

const mocks = vi.hoisted(() => ({
  getSessionInfo: vi.fn(),
  loadAllSessions: vi.fn(),
  sessionIdsWithTerminals: new Set<string>(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpGetSessionInfo: (...args: unknown[]) => mocks.getSessionInfo(...args),
}));

vi.mock("@/features/terminal/lib/terminalSessionManager", () => ({
  getChatSessionIdsWithTerminals: () => mocks.sessionIdsWithTerminals,
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
    mocks.sessionIdsWithTerminals = new Set();
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
    [
      "a live terminal",
      () => {
        // A shell nobody can see is a process nobody can stop: an idle chat
        // whose terminal still runs a dev server stays out of the sweep.
        mocks.sessionIdsWithTerminals = new Set(["stale"]);
        return {};
      },
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

describe("shouldSweepOnVisibility", () => {
  it("sweeps on the first restore and then once per interval", () => {
    expect(shouldSweepOnVisibility(null, 1_000, 3_600_000)).toBe(true);
    expect(shouldSweepOnVisibility(1_000, 1_000 + 60_000, 3_600_000)).toBe(
      false,
    );
    expect(shouldSweepOnVisibility(1_000, 1_000 + 3_600_000, 3_600_000)).toBe(
      true,
    );
  });
});

describe("useAutoArchiveSessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetStores();
    setAutoArchiveAfter("7-days");
    mocks.loadAllSessions.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not re-sweep on every restore of the window", async () => {
    const archiveSession = vi.fn();
    const { unmount } = renderHook(() =>
      useAutoArchiveSessions(archiveSession),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.loadAllSessions).toHaveBeenCalledTimes(1);

    // Minimise and restore a few times within minutes: no new sweep.
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(mocks.loadAllSessions).toHaveBeenCalledTimes(1);

    // An hour later a restore sweeps again.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.loadAllSessions.mock.calls.length).toBeGreaterThanOrEqual(2);

    unmount();
  });
});
