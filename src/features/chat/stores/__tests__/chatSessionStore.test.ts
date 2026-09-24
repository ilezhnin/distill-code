import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpSessionInfo } from "@/shared/api/acp";
import { workspaceAttachmentIdForPath } from "@/features/chat/lib/workspaceAttachments";
import { targetFromAgentModelSelection } from "@/features/chat/lib/sessionExecutionTarget";
import {
  CHAT_WORKSPACE_METADATA_STORAGE_KEY,
  type PersistedChatWorkspaceMetadata,
} from "../workspaceAttachmentPersistence";
import { type ChatSession, useChatSessionStore } from "../chatSessionStore";
import { useChatStore } from "../chatStore";

const mocks = vi.hoisted(() => ({
  acpCreateSession: vi.fn(),
  acpListSessionsPage: vi.fn(),
  archiveSession: vi.fn(),
  checkAllProviderStatus: vi.fn(),
  unarchiveSession: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpCreateSession: (...args: unknown[]) => mocks.acpCreateSession(...args),
  acpListSessionsPage: (...args: unknown[]) =>
    mocks.acpListSessionsPage(...args),
}));

vi.mock("@/features/providers/api/credentials", () => ({
  checkAllProviderStatus: (...args: unknown[]) =>
    mocks.checkAllProviderStatus(...args),
}));

vi.mock("@/shared/api/acpApi", () => ({
  archiveSession: (...args: unknown[]) => mocks.archiveSession(...args),
  unarchiveSession: (...args: unknown[]) => mocks.unarchiveSession(...args),
  renameSession: vi.fn().mockResolvedValue(undefined),
  updateSessionProject: vi.fn().mockResolvedValue(undefined),
}));

function resetStore() {
  useChatSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    isLoading: false,
    isLoadingMoreSessions: false,
    hasHydratedSessions: false,
    sessionPageCursor: null,
    hasMoreSessions: false,
    isRightRailOpen: false,
    activeWorkspaceBySession: {},
    archiveMutationBySessionId: {},
  });
}

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "session-1",
    title: "Test Session",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    messageCount: 0,
    ...overrides,
  };
}

function seedSession(overrides: Partial<ChatSession> = {}): ChatSession {
  const session = makeSession(overrides);
  useChatSessionStore.setState((state) => ({
    sessions: [session, ...state.sessions],
  }));
  return session;
}

function makeAcpSession(
  overrides: Partial<AcpSessionInfo> & { sessionId: string },
): AcpSessionInfo {
  const { sessionId, ...rest } = overrides;
  return {
    sessionId,
    title: "ACP Session",
    updatedAt: "2026-04-01T00:00:00.000Z",
    createdAt: "2026-04-01T00:00:00.000Z",
    lastMessageAt: null,
    archivedAt: null,
    userSetName: false,
    messageCount: 1,
    subtitle: null,
    workingDir: null,
    projectId: null,
    providerId: null,
    modelId: null,
    personaId: null,
    ...rest,
  };
}

function mockPage(
  sessions: AcpSessionInfo[] = [],
  nextCursor: string | null = null,
) {
  return { sessions, nextCursor };
}

function readPersistedWorkspaceMetadata(): Record<
  string,
  PersistedChatWorkspaceMetadata
> {
  return JSON.parse(
    window.localStorage.getItem(CHAT_WORKSPACE_METADATA_STORAGE_KEY) ?? "{}",
  );
}

function createDeferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("chatSessionStore", () => {
  beforeEach(() => {
    window.localStorage.removeItem("distill:right-rail-open");
    window.localStorage.removeItem("distill:context-panel-open");
    window.localStorage.removeItem(CHAT_WORKSPACE_METADATA_STORAGE_KEY);
    window.localStorage.removeItem("distill:unread-sessions");
    useChatStore.setState({ sessionStateById: {} });
    resetStore();
    vi.clearAllMocks();
    mocks.archiveSession.mockResolvedValue(undefined);
    mocks.checkAllProviderStatus.mockResolvedValue([]);
    mocks.unarchiveSession.mockResolvedValue(undefined);
  });

  describe("archiveSession", () => {
    it("rolls back to the backend-known archived state when overlapping unarchive and archive both fail", async () => {
      const priorArchivedAt = "2026-03-15T00:00:00.000Z";
      const unarchive = createDeferredPromise<void>();
      const archive = createDeferredPromise<void>();
      seedSession({ id: "session-1", archivedAt: priorArchivedAt });
      mocks.unarchiveSession.mockReturnValueOnce(unarchive.promise);
      mocks.archiveSession.mockReturnValueOnce(archive.promise);

      const unarchivePromise = useChatSessionStore
        .getState()
        .unarchiveSession("session-1");
      const archivePromise = useChatSessionStore
        .getState()
        .archiveSession("session-1");

      unarchive.reject(new Error("unarchive failed"));
      await expect(unarchivePromise).rejects.toThrow("unarchive failed");
      archive.reject(new Error("archive failed"));
      await expect(archivePromise).rejects.toThrow("archive failed");

      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBe(priorArchivedAt);
    });
  });

  describe("unarchiveSession", () => {
    it("uses an older successful archive as rollback base when a newer unarchive fails", async () => {
      const archive = createDeferredPromise<void>();
      const unarchive = createDeferredPromise<void>();
      seedSession({ id: "session-1" });
      mocks.archiveSession.mockReturnValueOnce(archive.promise);
      mocks.unarchiveSession.mockReturnValueOnce(unarchive.promise);

      const archivePromise = useChatSessionStore
        .getState()
        .archiveSession("session-1");
      const archivedAt = useChatSessionStore
        .getState()
        .getSession("session-1")?.archivedAt;
      const unarchivePromise = useChatSessionStore
        .getState()
        .unarchiveSession("session-1");

      archive.resolve(undefined);
      await archivePromise;
      unarchive.reject(new Error("unarchive failed"));
      await expect(unarchivePromise).rejects.toThrow("unarchive failed");

      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBe(archivedAt);
    });
  });

  describe("createSession", () => {
    it("promotes a pending draft session to the real ACP session id", () => {
      seedSession({
        id: "local-session",
        title: "New Chat",
        projectId: "project-1",
        executionTarget: {
          harnessId: "claude-acp",
          modelProviderId: "claude-acp",
        },
        workingDir: "/tmp/project",
        creationState: "pending",
      });
      useChatSessionStore.setState({
        activeSessionId: "local-session",
        activeWorkspaceBySession: {
          "local-session": { path: "/tmp/project", branch: "main" },
        },
      });

      useChatSessionStore
        .getState()
        .promoteDraftSession("local-session", "acp-session", {
          executionTarget: targetFromAgentModelSelection("claude-acp", {
            modelProviderId: "claude-acp",
            modelId: "gpt-4.1",
            modelName: "GPT-4.1",
          }),
        });

      const state = useChatSessionStore.getState();
      expect(state.getSession("local-session")).toBeUndefined();
      expect(state.getSession("acp-session")).toMatchObject({
        id: "acp-session",
        executionTarget: {
          modelId: "gpt-4.1",
          modelName: "GPT-4.1",
        },
        creationState: undefined,
        creationError: undefined,
      });
      expect(state.activeSessionId).toBe("acp-session");
      expect(state.activeWorkspaceBySession).toEqual({
        "acp-session": { path: "/tmp/project", branch: "main" },
      });
    });

    it("marks a pending draft session failed when ACP creation fails", () => {
      seedSession({
        id: "local-session",
        title: "New Chat",
        creationState: "pending",
      });

      useChatSessionStore
        .getState()
        .markSessionCreationFailed("local-session", "boom");

      expect(
        useChatSessionStore.getState().getSession("local-session"),
      ).toMatchObject({
        creationState: "failed",
        creationError: "boom",
      });
    });

    it("persists draft workspace attachments under the real ACP session id when promoting", () => {
      const draft = useChatSessionStore.getState().createDraftSession({
        title: "New Chat",
        executionTarget: {
          harnessId: "claude-acp",
          modelProviderId: "claude-acp",
        },
        workingDir: "/tmp/main",
        workspaceAttachments: [
          {
            id: workspaceAttachmentIdForPath("/tmp/main"),
            path: "/tmp/main",
            kind: "git-main-worktree",
            source: "inferred",
            branch: "main",
            usedByAgent: false,
          },
          {
            id: workspaceAttachmentIdForPath("/tmp/main-worktrees/feature"),
            path: "/tmp/main-worktrees/feature",
            kind: "git-linked-worktree",
            source: "created",
            branch: "feature",
            repositoryPath: "/tmp/main",
            worktreePath: "/tmp/main-worktrees/feature",
            usedByAgent: false,
          },
        ],
      });

      useChatSessionStore
        .getState()
        .promoteDraftSession(draft.id, "acp-session");

      const persisted = readPersistedWorkspaceMetadata();
      expect(persisted[draft.id]).toBeUndefined();
      expect(persisted["acp-session"]).toEqual({
        workspaceAttachments: useChatSessionStore
          .getState()
          .getSession("acp-session")?.workspaceAttachments,
        activeWorkspaceId: null,
        workingDir: "/tmp/main",
      });
    });
  });

  describe("run settings across a model change", () => {
    const opus = {
      harnessId: "claude-acp",
      modelProviderId: "claude-acp",
      modelId: "opus[1m]",
      modelName: "Opus 5",
    };
    const sonnet = { ...opus, modelId: "sonnet", modelName: "Sonnet 5" };
    const observedOnOpus: Partial<ChatSession> = {
      executionTarget: opus,
      executionTargetSource: "ui",
      reasoningEffort: {
        configId: "effort",
        currentValue: "xhigh",
        options: [
          { id: "high", name: "High" },
          { id: "xhigh", name: "Extra high" },
        ],
      },
      fastMode: { configId: "fast", enabled: true, kind: "select" },
      ultracodeArmed: true,
      runSettingsNotice: {
        kind: "effort",
        wanted: "max",
        actual: "xhigh",
        modelName: "Opus 5",
      },
      desiredRunSettings: { effort: "xhigh", fast: true },
    };

    it("keeps the operator's run settings and clears both observed menus when the model changes", () => {
      seedSession(observedOnOpus);

      useChatSessionStore
        .getState()
        .replaceSessionExecutionTarget("session-1", sonnet);

      const session = useChatSessionStore.getState().getSession("session-1");
      expect(session?.executionTarget?.modelId).toBe("sonnet");
      expect(session?.desiredRunSettings).toEqual({
        effort: "xhigh",
        fast: true,
      });
      expect(session?.reasoningEffort).toBeUndefined();
      expect(session?.fastMode).toBeUndefined();
      expect(session?.ultracodeArmed).toBeUndefined();
      expect(session?.runSettingsNotice).toBeUndefined();
    });
  });

  describe("loadSessions", () => {
    it("preserves a local persona tag when an ACP session row omits persona metadata", async () => {
      seedSession({
        id: "session-1",
        title: "Tagged chat",
        personaId: "persona-1",
        executionTarget: { harnessId: "claude-acp" },
        updatedAt: "2026-04-01T00:00:00.000Z",
      });

      mocks.acpListSessionsPage.mockResolvedValue(
        mockPage([
          makeAcpSession({
            sessionId: "session-1",
            title: "Tagged chat",
            providerId: "claude-acp",
            personaId: null,
            updatedAt: "2026-04-02T00:00:00.000Z",
          }),
        ]),
      );

      await useChatSessionStore.getState().loadSessions();

      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        personaId: "persona-1",
        updatedAt: "2026-04-02T00:00:00.000Z",
      });
    });

    it("hydrates the first page without dropping local sessions or clearing active session", async () => {
      const draft = makeSession({
        id: "draft-session",
        title: "Draft",
        creationState: "pending",
        updatedAt: "2026-04-03T00:00:00.000Z",
      });
      useChatSessionStore.setState({
        sessions: [
          draft,
          makeSession({
            id: "older-loaded-session",
            title: "Older Loaded Session",
            updatedAt: "2026-03-01T00:00:00.000Z",
          }),
        ],
        activeSessionId: "older-loaded-session",
      });

      mocks.acpListSessionsPage.mockResolvedValue(
        mockPage(
          [
            makeAcpSession({
              sessionId: "acp-1",
              updatedAt: "2026-04-02",
              createdAt: "2026-04-02",
            }),
          ],
          "cursor-2",
        ),
      );

      await useChatSessionStore.getState().loadSessions();

      const state = useChatSessionStore.getState();
      expect(state.sessions.map((session) => session.id)).toEqual([
        "draft-session",
        "acp-1",
        "older-loaded-session",
      ]);
      expect(state.activeSessionId).toBe("older-loaded-session");
      expect(state.sessionPageCursor).toBe("cursor-2");
      expect(state.hasMoreSessions).toBe(true);
    });

    it("preserves a pending optimistic archive when ACP returns stale unarchived state", async () => {
      const archive = createDeferredPromise<void>();
      seedSession({ id: "session-1" });
      mocks.archiveSession.mockReturnValueOnce(archive.promise);

      const archivePromise = useChatSessionStore
        .getState()
        .archiveSession("session-1");
      const optimisticArchivedAt = useChatSessionStore
        .getState()
        .getSession("session-1")?.archivedAt;
      expect(optimisticArchivedAt).toEqual(expect.any(String));

      mocks.acpListSessionsPage.mockResolvedValueOnce(
        mockPage([
          makeAcpSession({ sessionId: "session-1", archivedAt: null }),
        ]),
      );
      await useChatSessionStore.getState().loadSessions();

      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBe(optimisticArchivedAt);

      archive.resolve(undefined);
      await archivePromise;
    });

    it("rolls back a failed archive after a stale ACP page merged while pending", async () => {
      const priorArchivedAt = "2026-03-15T00:00:00.000Z";
      const archive = createDeferredPromise<void>();
      seedSession({ id: "session-1", archivedAt: priorArchivedAt });
      mocks.archiveSession.mockReturnValueOnce(archive.promise);

      const archivePromise = useChatSessionStore
        .getState()
        .archiveSession("session-1");
      const optimisticArchivedAt = useChatSessionStore
        .getState()
        .getSession("session-1")?.archivedAt;
      expect(optimisticArchivedAt).not.toBe(priorArchivedAt);

      mocks.acpListSessionsPage.mockResolvedValueOnce(
        mockPage([
          makeAcpSession({ sessionId: "session-1", archivedAt: null }),
        ]),
      );
      await useChatSessionStore.getState().loadSessions();
      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBe(optimisticArchivedAt);

      archive.reject(new Error("backend down"));
      await expect(archivePromise).rejects.toThrow("backend down");

      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBe(priorArchivedAt);
      expect(
        useChatSessionStore.getState().archiveMutationBySessionId,
      ).not.toHaveProperty("session-1");
    });

    it("appends the next page and advances the cursor", async () => {
      useChatSessionStore.setState({
        sessions: [
          makeSession({
            id: "acp-1",
            updatedAt: "2026-04-03T00:00:00.000Z",
          }),
        ],
        sessionPageCursor: "cursor-2",
        hasMoreSessions: true,
      });
      mocks.acpListSessionsPage.mockResolvedValue(
        mockPage(
          [
            makeAcpSession({
              sessionId: "acp-2",
              updatedAt: "2026-04-02T00:00:00.000Z",
            }),
          ],
          "cursor-3",
        ),
      );

      await useChatSessionStore.getState().loadMoreSessions();

      expect(mocks.acpListSessionsPage).toHaveBeenCalledWith({
        cursor: "cursor-2",
      });
      const state = useChatSessionStore.getState();
      expect(state.sessions.map((session) => session.id)).toEqual([
        "acp-1",
        "acp-2",
      ]);
      expect(state.sessionPageCursor).toBe("cursor-3");
      expect(state.hasMoreSessions).toBe(true);
    });

    it("stops pagination when the backend repeats a cursor", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      useChatSessionStore.setState({
        sessionPageCursor: "cursor-2",
        hasMoreSessions: true,
      });
      mocks.acpListSessionsPage.mockResolvedValue(
        mockPage(
          [
            makeAcpSession({
              sessionId: "acp-2",
              updatedAt: "2026-04-02T00:00:00.000Z",
            }),
          ],
          "cursor-2",
        ),
      );

      await useChatSessionStore.getState().loadMoreSessions();

      const state = useChatSessionStore.getState();
      expect(state.sessionPageCursor).toBeNull();
      expect(state.hasMoreSessions).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        "ACP session/list returned the same pagination cursor; stopping pagination to avoid an infinite loop.",
      );
      warnSpy.mockRestore();
    });

    it("does not apply stale loadMore results after loadSessions starts", async () => {
      const loadMore = createDeferredPromise<ReturnType<typeof mockPage>>();
      const loadFirstPage =
        createDeferredPromise<ReturnType<typeof mockPage>>();
      useChatSessionStore.setState({
        sessions: [
          makeSession({
            id: "existing-session",
            updatedAt: "2026-04-03T00:00:00.000Z",
          }),
        ],
        sessionPageCursor: "cursor-2",
        hasMoreSessions: true,
      });
      mocks.acpListSessionsPage
        .mockReturnValueOnce(loadMore.promise)
        .mockReturnValueOnce(loadFirstPage.promise);

      const loadMorePromise = useChatSessionStore.getState().loadMoreSessions();
      const loadSessionsPromise = useChatSessionStore.getState().loadSessions();

      loadFirstPage.resolve(
        mockPage([
          makeAcpSession({
            sessionId: "fresh-session",
            updatedAt: "2026-04-04T00:00:00.000Z",
          }),
        ]),
      );
      await loadSessionsPromise;

      loadMore.resolve(
        mockPage(
          [
            makeAcpSession({
              sessionId: "stale-session",
              updatedAt: "2026-04-05T00:00:00.000Z",
            }),
          ],
          "cursor-3",
        ),
      );
      await loadMorePromise;

      const state = useChatSessionStore.getState();
      expect(mocks.acpListSessionsPage).toHaveBeenNthCalledWith(1, {
        cursor: "cursor-2",
      });
      expect(mocks.acpListSessionsPage).toHaveBeenNthCalledWith(2);
      expect(state.sessions.map((session) => session.id)).toEqual([
        "fresh-session",
        "existing-session",
      ]);
      expect(state.sessionPageCursor).toBeNull();
      expect(state.hasMoreSessions).toBe(false);
      expect(state.isLoadingMoreSessions).toBe(false);
    });
  });

  describe("patchSession", () => {
    it("persists Goose-created workspace cleanup metadata", () => {
      const mainAttachmentId = workspaceAttachmentIdForPath("/tmp/main");
      const featurePath = "/tmp/main-worktrees/feature";
      const session = seedSession({
        workingDir: "/tmp/main",
        workspaceAttachments: [
          {
            id: mainAttachmentId,
            path: "/tmp/main",
            kind: "git-main-worktree",
            source: "inferred",
            branch: "main",
            usedByAgent: false,
          },
        ],
        activeWorkspaceId: mainAttachmentId,
      });

      useChatSessionStore.getState().attachWorkspace(session.id, {
        path: featurePath,
        branch: "feature",
        kind: "git-linked-worktree",
        source: "created",
        repositoryPath: "/tmp/main",
        worktreePath: featurePath,
        lifecycle: {
          owner: "distill",
          cleanup: "worktree",
          branch: "feature",
          baseBranch: "main",
          repositoryPath: "/tmp/main",
          worktreePath: featurePath,
          createdBranch: true,
        },
      });

      const updated = useChatSessionStore.getState().getSession(session.id);
      expect(updated?.workspaceAttachments?.[1]).toMatchObject({
        path: featurePath,
        source: "created",
        lifecycle: {
          owner: "distill",
          cleanup: "worktree",
          branch: "feature",
          baseBranch: "main",
          repositoryPath: "/tmp/main",
          worktreePath: featurePath,
          createdBranch: true,
        },
      });
      expect(readPersistedWorkspaceMetadata()[session.id]).toEqual({
        workspaceAttachments: updated?.workspaceAttachments,
        activeWorkspaceId: mainAttachmentId,
        workingDir: "/tmp/main",
      });
    });

    it("marks every included workspace as used by the agent when sending", () => {
      const session = seedSession({
        workingDir: "/tmp/main",
        workspaceAttachments: [
          {
            id: workspaceAttachmentIdForPath("/tmp/main"),
            path: "/tmp/main",
            kind: "git-main-worktree",
            source: "inferred",
            branch: "main",
            usedByAgent: false,
          },
          {
            id: workspaceAttachmentIdForPath("/tmp/main-worktrees/feature"),
            path: "/tmp/main-worktrees/feature",
            kind: "git-linked-worktree",
            source: "selected",
            branch: "feature",
            usedByAgent: false,
          },
        ],
      });

      useChatSessionStore.getState().markWorkspaceUsedByAgent(session.id);

      const updated = useChatSessionStore.getState().getSession(session.id);
      expect(
        updated?.workspaceAttachments?.map((attachment) => ({
          path: attachment.path,
          usedByAgent: attachment.usedByAgent,
        })),
      ).toEqual([
        { path: "/tmp/main", usedByAgent: true },
        { path: "/tmp/main-worktrees/feature", usedByAgent: true },
      ]);
      expect(readPersistedWorkspaceMetadata()[session.id]).toEqual({
        workspaceAttachments: updated?.workspaceAttachments,
        activeWorkspaceId: null,
        workingDir: "/tmp/main",
      });
    });
  });
});
