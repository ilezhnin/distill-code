import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspaceAttachmentIdForPath } from "@/features/chat/lib/workspaceAttachments";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import {
  CHAT_WORKSPACE_METADATA_STORAGE_KEY,
  persistChatWorkspaceMetadata,
} from "@/features/chat/stores/workspaceAttachmentPersistence";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import { useWorkspaceAttachmentSync } from "../useWorkspaceAttachmentSync";

const MAIN_ID = workspaceAttachmentIdForPath("/tmp/main");

function attachment(usedByAgent: boolean): WorkspaceAttachment {
  // Field order as the persistence layer normalizes it.
  return {
    id: MAIN_ID,
    path: "/tmp/main",
    kind: "git-main-worktree",
    source: "selected",
    branch: "main",
    usedByAgent,
  };
}

function seed(overrides: Partial<ChatSession> = {}): ChatSession {
  const session: ChatSession = {
    id: "session-1",
    title: "Session",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    messageCount: 1,
    workingDir: "/tmp/main",
    workspaceAttachments: [attachment(true)],
    activeWorkspaceId: MAIN_ID,
    ...overrides,
  };
  useChatSessionStore.setState({
    sessions: [session],
    activeWorkspaceBySession: {
      [session.id]: { path: "/tmp/main", branch: "main" },
    },
  });
  return session;
}

describe("useWorkspaceAttachmentSync", () => {
  beforeEach(() => {
    window.localStorage.removeItem(CHAT_WORKSPACE_METADATA_STORAGE_KEY);
  });

  afterEach(() => {
    useChatSessionStore.setState({
      sessions: [],
      activeWorkspaceBySession: {},
    });
    window.localStorage.removeItem(CHAT_WORKSPACE_METADATA_STORAGE_KEY);
  });

  it("leaves the store alone when the session already holds the change", () => {
    const session = seed();
    const { unmount } = renderHook(() => useWorkspaceAttachmentSync());
    const before = useChatSessionStore.getState();

    // What the store itself does: update the session, then persist it.
    persistChatWorkspaceMetadata(session.id, {
      workspaceAttachments: [attachment(true)],
      activeWorkspaceId: MAIN_ID,
      workingDir: "/tmp/main",
    });

    const after = useChatSessionStore.getState();
    expect(after.sessions).toBe(before.sessions);
    expect(after.activeWorkspaceBySession).toBe(
      before.activeWorkspaceBySession,
    );
    unmount();
  });

  it("applies metadata the session does not hold yet", () => {
    const session = seed({ workspaceAttachments: [attachment(false)] });
    const { unmount } = renderHook(() => useWorkspaceAttachmentSync());

    persistChatWorkspaceMetadata(session.id, {
      workspaceAttachments: [attachment(true)],
      activeWorkspaceId: MAIN_ID,
      workingDir: "/tmp/main",
    });

    const updated = useChatSessionStore.getState().sessions[0];
    expect(updated).not.toBe(session);
    expect(updated?.workspaceAttachments).toEqual([attachment(true)]);
    unmount();
  });

  it("clears the session's workspaces when their metadata is removed", () => {
    const session = seed();
    persistChatWorkspaceMetadata(session.id, {
      workspaceAttachments: [attachment(true)],
      activeWorkspaceId: MAIN_ID,
      workingDir: "/tmp/main",
    });
    const { unmount } = renderHook(() => useWorkspaceAttachmentSync());

    persistChatWorkspaceMetadata(session.id, {
      workspaceAttachments: [],
      activeWorkspaceId: null,
      workingDir: null,
    });

    const state = useChatSessionStore.getState();
    expect(state.sessions[0]?.workspaceAttachments).toEqual([]);
    expect(state.sessions[0]?.activeWorkspaceId).toBeNull();
    expect(state.activeWorkspaceBySession[session.id]).toBeUndefined();
    unmount();
  });
});
