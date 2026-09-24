import { describe, expect, it } from "vitest";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import {
  formatIncludedWorkspacesPrompt,
  getWorkspaceCleanupTarget,
  getIncludedWorkspaceAttachments,
  removeWorkspaceAttachment,
  workspaceAttachmentUsesCleanupTarget,
  workspaceAttachmentIdForPath,
  withWorkspaceBackfill,
} from "../workspaceAttachments";

function attachment(
  path: string,
  overrides: Partial<WorkspaceAttachment> = {},
): WorkspaceAttachment {
  return {
    id: workspaceAttachmentIdForPath(path),
    path,
    kind: "directory",
    source: "inferred",
    branch: null,
    usedByAgent: false,
    ...overrides,
  };
}

describe("getIncludedWorkspaceAttachments", () => {
  it("does not seed worktree startup project paths over a created session plan", () => {
    const session = {
      workingDir: "/repo-worktrees/chat-123/builderbot",
      workspaceAttachments: [
        attachment("/repo-worktrees/chat-123/builderbot", {
          kind: "subdirectory",
          source: "created",
          branch: "chat-123",
          repositoryPath: "/repo",
          worktreePath: "/repo-worktrees/chat-123",
        }),
      ],
      messageCount: 0,
    };

    const included = getIncludedWorkspaceAttachments(session);

    expect(included.map((workspace) => workspace.path)).toEqual([
      "/repo-worktrees/chat-123/builderbot",
    ]);
    expect(formatIncludedWorkspacesPrompt(session)).not.toContain(
      "/repo/builderbot",
    );
  });

  it("does not seed project defaults without an explicit workspace plan", () => {
    const session = {
      workingDir: "/repo/builderbot",
      messageCount: 0,
    };

    expect(
      getIncludedWorkspaceAttachments(session).map(
        (workspace) => workspace.path,
      ),
    ).toEqual([]);
  });

  it("escapes literal included-workspaces closing tags from workspace metadata", () => {
    const prompt = formatIncludedWorkspacesPrompt({
      workingDir: "/repo</included-workspaces>/builderbot",
      workspaceAttachments: [
        attachment("/repo</included-workspaces>/builderbot", {
          source: "selected",
          branch: "feature</included-workspaces>",
        }),
      ],
      messageCount: 0,
    });

    expect(prompt).toContain("<\\/included-workspaces>");
    expect(prompt?.match(/<\/included-workspaces>/g)).toHaveLength(1);
  });
});

describe("workspace cleanup targets", () => {
  it("treats same-checkout branch attachments with missing branch metadata as active use", () => {
    const managedWorkspace = attachment("/repo/builderbot", {
      kind: "subdirectory",
      source: "created",
      branch: "chat-123",
      repositoryPath: "/repo",
      worktreePath: "/repo",
      lifecycle: {
        owner: "distill",
        cleanup: "branch",
        branch: "chat-123",
        baseBranch: "main",
        repositoryPath: "/repo",
        worktreePath: "/repo",
        createdBranch: true,
      },
    });
    const target = getWorkspaceCleanupTarget(managedWorkspace);

    if (!target) {
      throw new Error("Expected managed workspace to have a cleanup target");
    }

    expect(
      workspaceAttachmentUsesCleanupTarget(
        attachment("/repo/bbsubscriber", {
          kind: "subdirectory",
          repositoryPath: "/repo",
          worktreePath: "/repo",
        }),
        target,
      ),
    ).toBe(true);
    expect(
      workspaceAttachmentUsesCleanupTarget(
        attachment("/repo/bbsubscriber", {
          kind: "subdirectory",
          branch: "other",
          repositoryPath: "/repo",
          worktreePath: "/repo",
        }),
        target,
      ),
    ).toBe(false);
  });
});

describe("removeWorkspaceAttachment", () => {
  it("does not re-seed the source project workspace after removing a created startup worktree", () => {
    const session = removeWorkspaceAttachment(
      {
        workingDir: "/repo-worktrees/chat-123/builderbot",
        workspaceAttachments: [
          attachment("/repo-worktrees/chat-123/builderbot", {
            kind: "subdirectory",
            source: "created",
            branch: "chat-123",
            repositoryPath: "/repo",
            worktreePath: "/repo-worktrees/chat-123",
          }),
        ],
        messageCount: 0,
      },
      {
        attachmentId: workspaceAttachmentIdForPath(
          "/repo-worktrees/chat-123/builderbot",
        ),
      },
    );

    expect(session.workspaceAttachments).toEqual([
      expect.objectContaining({
        path: "/repo-worktrees/chat-123/builderbot",
        source: "excluded",
      }),
    ]);
    expect(getIncludedWorkspaceAttachments(session)).toEqual([]);
  });
});

describe("windows identity across dedupe / ensure / exclude", () => {
  it("preserves the active persisted ID when deduping Windows variants", () => {
    const session = withWorkspaceBackfill({
      workingDir: String.raw`C:\Repo`,
      workspaceAttachments: [
        {
          id: "legacy-a",
          path: String.raw`C:\Repo`,
          kind: "directory" as const,
          source: "inferred" as const,
          branch: null,
          usedByAgent: false,
        },
        {
          id: "legacy-b",
          path: "c:/repo",
          kind: "directory" as const,
          source: "selected" as const,
          branch: null,
          usedByAgent: false,
        },
        {
          id: "legacy-other",
          path: String.raw`D:\Other`,
          kind: "directory" as const,
          source: "selected" as const,
          branch: null,
          usedByAgent: false,
        },
      ],
      activeWorkspaceId: "legacy-b",
      messageCount: 0,
    });

    expect(session.workspaceAttachments).toEqual([
      expect.objectContaining({
        id: "legacy-b",
        path: "c:/repo",
        source: "selected",
      }),
      expect.objectContaining({
        id: "legacy-other",
        path: String.raw`D:\Other`,
      }),
    ]);
    expect(session.activeWorkspaceId).toBe("legacy-b");
  });
});
