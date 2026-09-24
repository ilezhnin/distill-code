import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  attachSessionFolder,
  detachSessionFolder,
  replaceSessionFolder,
} from "./sessionFolderRegistration";

const mocks = vi.hoisted(() => ({
  canonicalizeAuthorizedWorkspaceDirectory: vi.fn(),
  resolvePath: vi.fn(),
  getGitState: vi.fn(),
  getHomeDir: vi.fn(),
  resolveArtifactRootPath: vi.fn(),
}));
vi.mock("@/shared/api/pathResolver", () => ({
  canonicalizeAuthorizedWorkspaceDirectory: (...args: unknown[]) =>
    mocks.canonicalizeAuthorizedWorkspaceDirectory(...args),
  resolvePath: (...args: unknown[]) => mocks.resolvePath(...args),
}));
vi.mock("@/shared/api/git", () => ({
  getGitState: (...args: unknown[]) => mocks.getGitState(...args),
}));
vi.mock("@/shared/api/system", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/system")>();
  return {
    ...actual,
    getHomeDir: (...args: unknown[]) => mocks.getHomeDir(...args),
  };
});
vi.mock(
  "@/shared/artifacts/sessionArtifactLocation",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/shared/artifacts/sessionArtifactLocation")
      >();
    return {
      ...actual,
      resolveArtifactRootPath: () => mocks.resolveArtifactRootPath(),
    };
  },
);

const session = {
  id: "session-1",
  title: "Test",
  workingDir: "/repo",
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
  messageCount: 1,
};
const gitState = {
  isGitRepo: true,
  currentBranch: "feature",
  dirtyFileCount: 0,
  incomingCommitCount: 0,
  worktrees: [
    { path: "/repo", branch: "main", isMain: true },
    { path: "/repo-wt", branch: "feature", isMain: false },
  ],
  isWorktree: true,
  mainWorktreePath: "/repo",
  localBranches: ["main", "feature"],
};

describe("attachSessionFolder", () => {
  beforeEach(() => {
    localStorage.clear();
    useChatSessionStore.setState({
      sessions: [{ ...session }],
      activeSessionId: null,
      activeWorkspaceBySession: {},
      hasHydratedSessions: true,
    });
    mocks.canonicalizeAuthorizedWorkspaceDirectory
      .mockReset()
      .mockImplementation(async ({ path }: { path: string }) => ({
        path: path === "/repo-wt/../repo-wt" ? "/repo-wt" : path,
      }));
    mocks.resolvePath
      .mockReset()
      .mockImplementation(async ({ parts }: { parts: string[] }) => ({
        path: parts[0],
      }));
    mocks.getGitState.mockReset().mockResolvedValue(gitState);
    mocks.getHomeDir.mockReset().mockResolvedValue("/Users/me");
    mocks.resolveArtifactRootPath.mockReset().mockResolvedValue("/artifacts");
  });

  it("merges concurrent registrations against current store state", async () => {
    const first = attachSessionFolder("session-1", "/first");
    const second = attachSessionFolder("session-1", "/second");
    await Promise.all([first, second]);

    const paths = useChatSessionStore
      .getState()
      .getSession("session-1")
      ?.workspaceAttachments?.map((item) => item.path);
    expect(paths).toEqual(expect.arrayContaining(["/first", "/second"]));
  });

  it("rejects authorization revoked after preparation but before mutation", async () => {
    let releaseArtifactRoot: (() => void) | undefined;
    const artifactRootBlocked = new Promise<void>((resolve) => {
      releaseArtifactRoot = resolve;
    });
    mocks.resolveArtifactRootPath.mockImplementationOnce(async () => {
      await artifactRootBlocked;
      return "/artifacts";
    });
    mocks.getGitState.mockImplementation(async (path: string) =>
      path === "/replacement"
        ? { ...gitState, isGitRepo: false, worktrees: [] }
        : gitState,
    );
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockImplementation(
      async ({
        path,
        allowedRoots,
      }: {
        path: string;
        allowedRoots: string[];
      }) => {
        if (!allowedRoots.some((root) => path.startsWith(root))) {
          throw new Error("outside authorized roots");
        }
        return { path };
      },
    );

    const registration = attachSessionFolder("session-1", "/repo/child");
    await vi.waitFor(() =>
      expect(mocks.resolveArtifactRootPath).toHaveBeenCalledTimes(1),
    );
    useChatSessionStore.setState({
      sessions: [{ ...session, workingDir: "/replacement" }],
    });
    releaseArtifactRoot?.();

    await expect(registration).rejects.toThrow("outside authorized roots");
    expect(
      useChatSessionStore
        .getState()
        .getSession("session-1")
        ?.workspaceAttachments?.some(
          (attachment) => attachment.path === "/repo/child",
        ),
    ).not.toBe(true);
  });

  it("does not let an excluded attachment expand path authority", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          ...session,
          workspaceAttachments: [
            {
              id: "path:/secret",
              path: "/secret",
              kind: "directory",
              source: "excluded",
              branch: null,
              usedByAgent: false,
            },
          ],
        },
      ],
    });

    await attachSessionFolder("session-1", "/repo/child");

    expect(mocks.canonicalizeAuthorizedWorkspaceDirectory).toHaveBeenCalledWith(
      {
        path: "/repo/child",
        allowedRoots: ["/repo", "/repo-wt"],
      },
    );
    expect(mocks.getGitState).not.toHaveBeenCalledWith("/secret");
  });

  it("rejects a path when canonical directory verification fails", async () => {
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockRejectedValue(
      new Error("not a directory"),
    );
    await expect(
      attachSessionFolder("session-1", "/secret.txt"),
    ).rejects.toThrow("not a directory");
    expect(
      useChatSessionStore.getState().getSession("session-1")
        ?.workspaceAttachments,
    ).toBeUndefined();
  });

  it("keeps the old attachment when replacement validation fails", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          ...session,
          workspaceAttachments: [
            {
              id: "path:/repo",
              path: "/repo",
              kind: "git-main-worktree",
              source: "selected",
              branch: "main",
              usedByAgent: true,
            },
          ],
        },
      ],
    });
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockImplementation(
      async ({ path }: { path: string }) => {
        if (path === "/secret") throw new Error("outside authorized roots");
        return { path };
      },
    );

    await expect(
      replaceSessionFolder("session-1", "/repo", "/secret"),
    ).rejects.toThrow("outside authorized roots");
    expect(
      useChatSessionStore
        .getState()
        .getSession("session-1")
        ?.workspaceAttachments?.find((item) => item.path === "/repo"),
    ).toMatchObject({ source: "selected", branch: "main" });
  });

  it("re-evaluates cwd ownership after replacement validation", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          ...session,
          workingDir: "/other",
          workspaceAttachments: [
            {
              id: "path:/repo",
              path: "/repo",
              kind: "git-main-worktree",
              source: "selected",
              branch: "main",
              usedByAgent: true,
            },
          ],
        },
      ],
    });
    let releaseInspection: (() => void) | undefined;
    const inspectionBlocked = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    mocks.getGitState.mockImplementationOnce(async () => {
      await inspectionBlocked;
      return gitState;
    });

    const replacement = replaceSessionFolder("session-1", "/repo", "/repo-wt");
    await vi.waitFor(() => expect(mocks.getGitState).toHaveBeenCalled());
    useChatSessionStore.getState().patchSession("session-1", {
      workingDir: "/repo",
    });
    releaseInspection?.();

    await expect(replacement).resolves.toMatchObject({
      cwd: "/repo-wt",
      cwdStatus: "pending",
    });
  });

  it("falls back to the first remaining attachment when detaching cwd", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          ...session,
          workspaceAttachments: [
            {
              id: "path:/repo",
              path: "/repo",
              kind: "git-main-worktree",
              source: "selected",
              branch: "main",
              usedByAgent: true,
            },
            {
              id: "path:/repo-wt",
              path: "/repo-wt",
              kind: "git-linked-worktree",
              source: "selected",
              branch: "feature",
              usedByAgent: true,
            },
          ],
          activeWorkspaceId: "path:/repo",
        },
      ],
    });

    const result = await detachSessionFolder("session-1", "/repo");

    expect(result).toMatchObject({
      detached: true,
      cwd: "/repo-wt",
      cwdStatus: "pending",
    });
    const { getPendingSessionWorkspaceActivation } = await import(
      "@/features/chat/lib/sessionWorkspaceActivation"
    );
    expect(getPendingSessionWorkspaceActivation("session-1")).toMatchObject({
      path: "/repo-wt",
    });
  });
});
