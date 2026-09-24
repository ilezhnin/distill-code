import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRelativeWorkspacePath } from "@/features/chat/lib/workspaceAttachments";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import { useWorkspaceGitRuntimes } from "./useWorkspaceGitRuntimes";

const mocks = vi.hoisted(() => ({
  homeDir: null as string | null,
  getGitState: vi.fn(),
  getChangedFiles: vi.fn(),
}));

vi.mock("@/shared/hooks/useHomeDir", () => ({
  useHomeDir: () => mocks.homeDir,
}));

vi.mock("@/shared/api/git", () => ({
  getGitState: (...args: unknown[]) => mocks.getGitState(...args),
  getChangedFiles: (...args: unknown[]) => mocks.getChangedFiles(...args),
}));

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("useWorkspaceGitRuntimes", () => {
  beforeEach(() => {
    mocks.homeDir = null;
    mocks.getGitState.mockReset().mockResolvedValue({
      isGitRepo: false,
      currentBranch: null,
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [],
      isWorktree: false,
      mainWorktreePath: null,
      localBranches: [],
    });
    mocks.getChangedFiles.mockReset().mockResolvedValue([]);
  });

  it("exposes an expanded comparable workspace so a `~`-spelled subdirectory keeps its suffix in worktree path math", async () => {
    mocks.homeDir = "/Users/test";
    mocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "main",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [
        { path: "/Users/test/project", branch: "main", isMain: true },
      ],
      isWorktree: false,
      mainWorktreePath: "/Users/test/project",
      localBranches: ["main"],
    });

    const queryClient = new QueryClient();
    const workspaces: WorkspaceAttachment[] = [
      {
        id: "ws-sub",
        path: "~/project/packages/app",
        kind: "directory",
        source: "selected",
        usedByAgent: false,
      },
    ];

    const { result } = renderHook(() => useWorkspaceGitRuntimes(workspaces), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() =>
      expect(result.current[0]?.gitContext.canUseGitActions).toBe(true),
    );
    const runtime = result.current[0];
    // The raw spelling stays on `workspace` for session lookups by path/id…
    expect(runtime?.workspace.path).toBe("~/project/packages/app");
    // …while `comparableWorkspace` carries the expanded spelling so the
    // ContextPanel worktree-select/create handlers can compare it against the
    // absolute `gitContext.worktreePath` without dropping the `/packages/app`
    // suffix on a worktree switch.
    expect(runtime?.comparableWorkspace.path).toBe(
      "/Users/test/project/packages/app",
    );
    expect(runtime?.gitContext.worktreePath).toBe("/Users/test/project");
    expect(
      getRelativeWorkspacePath(
        runtime?.comparableWorkspace.path ?? "",
        runtime?.gitContext.worktreePath,
      ),
    ).toBe("packages/app");
  });
});
