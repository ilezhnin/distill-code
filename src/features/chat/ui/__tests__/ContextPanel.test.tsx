import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as gitApi from "@/shared/api/git";
import type { GitStateChangedPayload } from "@/shared/api/git";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import type { GitState } from "@/shared/types/git";
import {
  enrichWorkspaceAttachmentWithGitState,
  workspaceAttachmentIdForPath,
} from "@/features/chat/lib/workspaceAttachments";
import { useChatSessionStore } from "../../stores/chatSessionStore";
import { useChatStore } from "../../stores/chatStore";
import { getWorkspaceGitContext } from "../widgets/WorkspaceIdentity";
import { ContextPanel } from "../ContextPanel";
import { setMultiWorkspaceEnabled } from "@/features/workspaces/multiWorkspacePreference";

const {
  mockUseGitState,
  mockUseWorkspaceGitRuntimes,
  mockUseWorkspaceChangedFilesRuntimes,
  mockRefetch,
  mockRefetchFiles,
  mockListDirectoryEntries,
  mockGetAllSessionArtifacts,
  mockEnsureDirectory,
  mockUpdateWorkingDir,
  mockOpenDialog,
  mockToastError,
  mockToastSuccess,
  mockListenGitStateChanged,
  gitStateChangedHandlers,
} = vi.hoisted(() => {
  const gitStateChangedHandlers: Array<
    (payload: GitStateChangedPayload) => void
  > = [];

  return {
    mockUseGitState: vi.fn(),
    mockUseWorkspaceGitRuntimes: vi.fn(),
    mockUseWorkspaceChangedFilesRuntimes: vi.fn(),
    mockRefetch: vi.fn(),
    mockRefetchFiles: vi.fn(),
    mockListDirectoryEntries: vi.fn(),
    mockGetAllSessionArtifacts: vi.fn(),
    mockEnsureDirectory: vi.fn(),
    mockUpdateWorkingDir: vi.fn(),
    mockOpenDialog: vi.fn(),
    mockToastError: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockListenGitStateChanged: vi.fn(
      (handler: (payload: GitStateChangedPayload) => void) => {
        gitStateChangedHandlers.push(handler);
        return Promise.resolve(() => {});
      },
    ),
    gitStateChangedHandlers,
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: mockToastError,
    success: mockToastSuccess,
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock("@/shared/hooks/useGitState", () => ({
  useGitState: (...args: unknown[]) => mockUseGitState(...args),
}));

vi.mock("@/shared/hooks/useChangedFiles", () => ({
  useChangedFiles: () => ({
    data: [],
    isLoading: false,
    refetch: mockRefetchFiles,
  }),
}));

vi.mock("../hooks/useWorkspaceGitRuntimes", () => ({
  useWorkspaceGitRuntimes: (...args: unknown[]) =>
    mockUseWorkspaceGitRuntimes(...args),
  useWorkspaceChangedFilesRuntimes: (...args: unknown[]) =>
    mockUseWorkspaceChangedFilesRuntimes(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

vi.mock("@/shared/api/system", () => ({
  listDirectoryEntries: mockListDirectoryEntries,
  ensureDirectory: mockEnsureDirectory,
}));

vi.mock("@/shared/hooks/useHomeDir", () => ({
  useHomeDir: () => "/Users/test",
}));

vi.mock("@/shared/api/acpApi", () => ({
  updateWorkingDir: mockUpdateWorkingDir,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mockOpenDialog,
}));

vi.mock("@/shared/api/git", () => ({
  createBranch: vi.fn(),
  createWorktree: vi.fn(),
  deleteBranch: vi.fn(),
  fetchRepo: vi.fn(),
  getGitState: vi.fn(),
  pullRepo: vi.fn(),
  removeWorktree: vi.fn(),
  switchBranch: vi.fn(),
  stashChanges: vi.fn(),
  initRepo: vi.fn(),
  listenGitStateChanged: mockListenGitStateChanged,
}));

vi.mock("../../hooks/ArtifactPolicyContext", () => ({
  useArtifactActionsContext: () => ({
    openResolvedPath: vi.fn(),
    openInApp: vi.fn().mockResolvedValue(undefined),
    pathExists: () => Promise.resolve(true),
  }),
  useSessionArtifacts: () => mockGetAllSessionArtifacts(),
}));

describe("ContextPanel", () => {
  const DEFAULT_PROJECT_WORKING_DIRS = ["/Users/test/goose2"];
  const getWorkspaceActionsMenuButton = (name: RegExp | string = /goose2/i) =>
    screen.getByRole("button", {
      name:
        name instanceof RegExp
          ? new RegExp(`open actions for .*${name.source}`, "i")
          : new RegExp(`open actions for .*${name}`, "i"),
    });
  const openWorkspaceActionsMenu = async (
    user: ReturnType<typeof userEvent.setup>,
    name?: RegExp | string,
  ) => {
    await user.click(getWorkspaceActionsMenuButton(name));
  };
  const materializedWorkspace = (path: string): WorkspaceAttachment => ({
    id: workspaceAttachmentIdForPath(path),
    path,
    kind: "directory",
    source: "inferred",
    branch: null,
    usedByAgent: false,
  });
  const ensurePanelSession = (
    sessionId: string,
    workingDirs: string[],
    sessionWorkingDir?: string | null,
  ) => {
    const store = useChatSessionStore.getState();
    if (store.sessions.some((session) => session.id === sessionId)) {
      return;
    }

    const workingDir = sessionWorkingDir ?? workingDirs[0];
    if (!workingDir) {
      return;
    }

    useChatSessionStore.setState((state) => ({
      sessions: [
        {
          id: sessionId,
          title: "Chat",
          workingDir,
          workspaceAttachments: workingDirs.map(materializedWorkspace),
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
        ...state.sessions,
      ],
    }));
  };
  const renderContextPanel = (
    props: Partial<Parameters<typeof ContextPanel>[0]> = {},
  ) => {
    const sessionId = props.sessionId ?? "test-session";
    const projectWorkingDirs =
      props.projectWorkingDirs ?? DEFAULT_PROJECT_WORKING_DIRS;
    ensurePanelSession(sessionId, projectWorkingDirs, props.sessionWorkingDir);

    return render(
      <QueryClientProvider client={new QueryClient()}>
        <ContextPanel
          {...props}
          sessionId={sessionId}
          projectWorkingDirs={projectWorkingDirs}
        />
      </QueryClientProvider>,
    );
  };
  const gitProbePathForWorkspace = (workspace: WorkspaceAttachment) =>
    (
      workspace.worktreePath ??
      workspace.repositoryPath ??
      workspace.path
    ).replace(/\/+$/, "");
  const createWorkspaceRuntime = (
    workspace: WorkspaceAttachment,
    gitState: GitState | undefined,
    overrides: {
      error?: Error | null;
      isLoading?: boolean;
      isFetching?: boolean;
    } = {},
  ) => {
    const enrichedWorkspace = enrichWorkspaceAttachmentWithGitState(
      workspace,
      gitState,
    );
    return {
      workspace: enrichedWorkspace,
      comparableWorkspace: enrichedWorkspace,
      originalWorkspace: workspace,
      gitProbePath: gitProbePathForWorkspace(workspace),
      gitState,
      gitContext: getWorkspaceGitContext(enrichedWorkspace, gitState),
      isLoading: overrides.isLoading ?? false,
      isFetching: overrides.isFetching ?? false,
      error: overrides.error ?? null,
      refetch: mockRefetch,
    };
  };
  const createManagedWorktreeAttachment = (
    path: string,
    worktreePath: string,
    overrides: Partial<WorkspaceAttachment> = {},
  ): WorkspaceAttachment => ({
    id: workspaceAttachmentIdForPath(path),
    path,
    kind: "subdirectory",
    source: "created",
    branch: "feat/context-panel",
    repositoryPath: "/Users/test/goose2",
    worktreePath,
    lifecycle: {
      owner: "distill",
      cleanup: "worktree",
      branch: "feat/context-panel",
      baseBranch: "main",
      repositoryPath: "/Users/test/goose2",
      worktreePath,
      createdBranch: true,
    },
    usedByAgent: false,
    ...overrides,
  });
  const ensurePointerCaptureMethods = () => {
    if (!Element.prototype.hasPointerCapture) {
      Object.defineProperty(Element.prototype, "hasPointerCapture", {
        configurable: true,
        value: () => false,
      });
    }
    if (!Element.prototype.setPointerCapture) {
      Object.defineProperty(Element.prototype, "setPointerCapture", {
        configurable: true,
        value: () => undefined,
      });
    }
    if (!Element.prototype.releasePointerCapture) {
      Object.defineProperty(Element.prototype, "releasePointerCapture", {
        configurable: true,
        value: () => undefined,
      });
    }
    if (!Element.prototype.scrollIntoView) {
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        value: () => undefined,
      });
    }
  };

  beforeEach(() => {
    ensurePointerCaptureMethods();
    vi.clearAllMocks();
    gitStateChangedHandlers.length = 0;
    window.localStorage.clear();
    setMultiWorkspaceEnabled(true);
    useChatStore.setState({ messagesBySession: {}, sessionStateById: {} });
    useChatSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      isLoadingMoreSessions: false,
      hasHydratedSessions: true,
      sessionPageCursor: null,
      hasMoreSessions: false,
      isRightRailOpen: false,
      activeWorkspaceBySession: {},
    });
    mockRefetch.mockResolvedValue(undefined);
    mockRefetchFiles.mockResolvedValue(undefined);
    mockListDirectoryEntries.mockResolvedValue([]);
    mockEnsureDirectory.mockResolvedValue(undefined);
    mockUpdateWorkingDir.mockResolvedValue(undefined);
    mockOpenDialog.mockResolvedValue(null);
    mockGetAllSessionArtifacts.mockReturnValue([]);
    vi.mocked(gitApi.createWorktree).mockResolvedValue({
      path: "/Users/test/goose2-worktrees/new-worktree",
      branch: "new-worktree",
    });
    vi.mocked(gitApi.deleteBranch).mockResolvedValue(undefined);
    vi.mocked(gitApi.removeWorktree).mockResolvedValue(undefined);
    vi.mocked(gitApi.getGitState).mockResolvedValue({
      isGitRepo: true,
      currentBranch: "main",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [
        {
          path: "/Users/test/builderbot",
          branch: "main",
          isMain: true,
        },
        {
          path: "/Users/test/builderbot-feature",
          branch: "feat/chat-worktrees",
          isMain: false,
        },
      ],
      isWorktree: false,
      mainWorktreePath: "/Users/test/builderbot",
      localBranches: ["main", "dev"],
    });
    mockUseGitState.mockReturnValue({
      data: {
        isGitRepo: true,
        currentBranch: "main",
        dirtyFileCount: 3,
        incomingCommitCount: 0,
        worktrees: [
          {
            path: "/Users/test/goose2",
            branch: "main",
            isMain: true,
          },
          {
            path: "/Users/test/goose2-feature",
            branch: "feat/context-panel",
            isMain: false,
          },
        ],
        isWorktree: false,
        mainWorktreePath: "/Users/test/goose2",
        localBranches: ["main", "feat/context-panel", "dev", "old-feature"],
      },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mockRefetch,
    });
    mockUseWorkspaceGitRuntimes.mockImplementation(
      (workspaces: WorkspaceAttachment[]) => {
        const queryResult = mockUseGitState();
        return workspaces.map((workspace) =>
          createWorkspaceRuntime(workspace, queryResult.data),
        );
      },
    );
    mockUseWorkspaceChangedFilesRuntimes.mockReturnValue([]);
  });

  it("cleans up a last-use Distill-created worktree before removing it from the chat", async () => {
    const user = userEvent.setup();
    const worktreePath = "/Users/test/goose2-feature";
    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-remove-created-worktree",
          title: "Chat",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath(worktreePath),
              path: worktreePath,
              kind: "git-linked-worktree",
              source: "created",
              branch: "feat/context-panel",
              repositoryPath: "/Users/test/goose2",
              worktreePath,
              lifecycle: {
                owner: "distill",
                cleanup: "worktree",
                branch: "feat/context-panel",
                baseBranch: "main",
                repositoryPath: "/Users/test/goose2",
                worktreePath,
                createdBranch: true,
              },
              usedByAgent: false,
            },
          ],
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    renderContextPanel({
      sessionId: "test-session-remove-created-worktree",
      projectWorkingDirs: [],
    });

    await openWorkspaceActionsMenu(user);
    await user.click(
      screen.getByRole("menuitem", { name: /^remove from chat$/i }),
    );
    expect(
      await screen.findByRole("heading", {
        name: /^are you sure you want to remove this worktree\?$/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/goose2-feature will be deleted from disk\./i),
    ).toBeInTheDocument();
    await user.click(
      await screen.findByRole("button", { name: /^remove workspace$/i }),
    );

    expect(vi.mocked(gitApi.removeWorktree)).toHaveBeenCalledWith(
      "/Users/test/goose2",
      worktreePath,
      true,
    );
    expect(vi.mocked(gitApi.deleteBranch)).toHaveBeenCalledWith(
      "/Users/test/goose2",
      "feat/context-panel",
      true,
      "main",
    );
    expect(
      useChatSessionStore
        .getState()
        .getSession("test-session-remove-created-worktree")
        ?.workspaceAttachments,
    ).toEqual([]);
  });

  it("keeps a created branch when a `~`-spelled sibling still uses the checkout", async () => {
    const user = userEvent.setup();
    const homeDir = "/Users/test";
    // Mirror useWorkspaceGitRuntimes' `~` handling so the raw sibling renders
    // as it does in the app: derived against the expanded spelling, raw path
    // restored on `workspace`.
    mockUseWorkspaceGitRuntimes.mockImplementation(
      (workspaces: WorkspaceAttachment[]) => {
        const queryResult = mockUseGitState();
        return workspaces.map((workspace) => {
          const expanded = {
            ...workspace,
            path: workspace.path.replace(/^~(?=\/|$)/, homeDir),
          };
          const runtime = createWorkspaceRuntime(expanded, queryResult.data);
          return {
            ...runtime,
            workspace: { ...runtime.workspace, path: workspace.path },
            originalWorkspace: workspace,
          };
        });
      },
    );
    const createdPath = "/Users/test/goose2";
    const createdAttachment: WorkspaceAttachment = {
      id: workspaceAttachmentIdForPath(createdPath),
      path: createdPath,
      kind: "git-main-worktree",
      source: "created",
      branch: "feat/context-panel",
      repositoryPath: createdPath,
      worktreePath: createdPath,
      lifecycle: {
        owner: "distill",
        cleanup: "branch",
        branch: "feat/context-panel",
        baseBranch: "main",
        repositoryPath: createdPath,
        worktreePath: createdPath,
        createdBranch: true,
      },
      usedByAgent: false,
    };
    const tildeSibling = materializedWorkspace("~/goose2/docs");

    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-tilde-sibling",
          title: "Chat",
          workspaceAttachments: [createdAttachment, tildeSibling],
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    renderContextPanel({
      sessionId: "test-session-tilde-sibling",
      projectWorkingDirs: [],
    });

    await openWorkspaceActionsMenu(user, /goose2$/);
    await user.click(
      screen.getByRole("menuitem", { name: /^remove from chat$/i }),
    );

    // The `~`-spelled sibling still uses the checkout — its raw path only
    // matches the absolute cleanup target in the home-expanded spelling — so
    // the branch is kept and the workspace removes without a cleanup dialog.
    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("test-session-tilde-sibling")
          ?.workspaceAttachments,
      ).toEqual([tildeSibling]);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(vi.mocked(gitApi.deleteBranch)).not.toHaveBeenCalled();
  });

  it("identifies a managed worktree used by another active chat", async () => {
    const user = userEvent.setup();
    const worktreePath = "/Users/test/goose2-feature";
    const attachment = createManagedWorktreeAttachment(
      `${worktreePath}/app`,
      worktreePath,
    );
    const otherAttachment = createManagedWorktreeAttachment(
      `${worktreePath}/docs`,
      worktreePath,
    );

    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-shared-worktree-current",
          title: "Current chat",
          workspaceAttachments: [attachment],
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
        {
          id: "test-session-shared-worktree-other",
          title: "Other chat",
          workspaceAttachments: [otherAttachment],
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    renderContextPanel({
      sessionId: "test-session-shared-worktree-current",
      projectWorkingDirs: [],
    });

    await openWorkspaceActionsMenu(user, /app/i);
    await user.click(
      screen.getByRole("menuitem", { name: /^remove from chat$/i }),
    );

    expect(
      await screen.findByText(
        /another active chat uses the same Distill-created worktree/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/another workspace in this chat/i),
    ).not.toBeInTheDocument();
  });

  it("keeps a Distill-created worktree attached when cleanup fails", async () => {
    const user = userEvent.setup();
    const worktreePath = "/Users/test/goose2-feature";
    const attachment = createManagedWorktreeAttachment(
      worktreePath,
      worktreePath,
      { kind: "git-linked-worktree" },
    );
    vi.mocked(gitApi.removeWorktree).mockRejectedValueOnce(
      new Error("worktree is dirty"),
    );

    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-remove-worktree-cleanup-fails",
          title: "Chat",
          workspaceAttachments: [attachment],
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    renderContextPanel({
      sessionId: "test-session-remove-worktree-cleanup-fails",
      projectWorkingDirs: [],
    });

    await openWorkspaceActionsMenu(user);
    await user.click(
      screen.getByRole("menuitem", { name: /^remove from chat$/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: /^remove workspace$/i }),
    );

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        expect.stringContaining("worktree is dirty"),
      );
    });
    expect(vi.mocked(gitApi.removeWorktree)).toHaveBeenCalledWith(
      "/Users/test/goose2",
      worktreePath,
      true,
    );
    expect(vi.mocked(gitApi.deleteBranch)).not.toHaveBeenCalled();
    expect(
      useChatSessionStore
        .getState()
        .getSession("test-session-remove-worktree-cleanup-fails")
        ?.workspaceAttachments,
    ).toEqual([attachment]);
    expect(
      screen.getByRole("button", { name: /^remove workspace$/i }),
    ).toBeInTheDocument();
  });
});
