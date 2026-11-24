import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { AcpSessionInfo, AcpSessionsPage } from "@/shared/api/acp";
import { useSidebarChatAutoLoad } from "../useSidebarChatAutoLoad";

const mocks = vi.hoisted(() => ({
  acpListSessionsPage: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpListSessionsPage: (...args: unknown[]) =>
    mocks.acpListSessionsPage(...args),
}));

function chat(
  sessionId: string,
  overrides: Partial<AcpSessionInfo> = {},
): AcpSessionInfo {
  return {
    sessionId,
    title: sessionId,
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
    ...overrides,
  };
}

/** A host that hands out the given pages by cursor, the first one for none. */
function hostWithPages(pages: Record<string, AcpSessionsPage>) {
  mocks.acpListSessionsPage.mockImplementation(
    async ({ cursor }: { cursor?: string | null } = {}) => {
      const page = pages[cursor ?? "first"];
      if (!page) throw new Error(`No page for cursor ${cursor}`);
      return page;
    },
  );
}

describe("useSidebarChatAutoLoad", () => {
  beforeEach(() => {
    mocks.acpListSessionsPage.mockReset();
    useChatSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      isLoadingMoreSessions: false,
      hasHydratedSessions: false,
      hasStartedSessionPaging: false,
      sessionPageCursor: null,
      hasMoreSessions: false,
      hasMoreActiveSessions: false,
      archiveMutationBySessionId: {},
    });
  });

  it("reads on until a project's old chats are in, and leaves the archive unread", async () => {
    hostWithPages({
      first: {
        sessions: [chat("today", { projectId: "busy-project" })],
        nextCursor: "page-2",
        activeComplete: false,
      },
      "page-2": {
        sessions: [chat("yesterday", { projectId: "busy-project" })],
        nextCursor: "page-3",
        activeComplete: false,
      },
      // The quiet project's only chat is months old and was never archived:
      // it sits behind every newer chat, on the last page that has one.
      "page-3": {
        sessions: [
          chat("months-ago", {
            projectId: "quiet-project",
            updatedAt: "2025-11-01T00:00:00.000Z",
          }),
          chat("archived-1", { archivedAt: "2026-04-02T00:00:00.000Z" }),
        ],
        nextCursor: "page-4",
        activeComplete: true,
      },
      "page-4": {
        sessions: [
          chat("archived-2", { archivedAt: "2026-03-02T00:00:00.000Z" }),
        ],
        nextCursor: null,
        activeComplete: true,
      },
    });
    await useChatSessionStore.getState().loadSessions();

    renderHook(() => useSidebarChatAutoLoad(true));

    await waitFor(() =>
      expect(useChatSessionStore.getState().hasMoreActiveSessions).toBe(false),
    );
    const state = useChatSessionStore.getState();
    expect(
      state.sessions
        .filter((session) => session.projectId === "quiet-project")
        .map((session) => session.id),
    ).toEqual(["months-ago"]);
    // The archive is still there to read, and nobody asked for it.
    expect(state.hasMoreSessions).toBe(true);
    expect(state.sessionPageCursor).toBe("page-4");
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(3);
  });

  it("does not read pages for a preview of the list", async () => {
    hostWithPages({
      first: {
        sessions: [chat("today")],
        nextCursor: "page-2",
        activeComplete: false,
      },
    });
    await useChatSessionStore.getState().loadSessions();

    renderHook(() => useSidebarChatAutoLoad(false));
    await Promise.resolve();

    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(1);
    expect(useChatSessionStore.getState().hasMoreActiveSessions).toBe(true);
  });
});
