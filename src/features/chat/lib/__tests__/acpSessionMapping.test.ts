import { beforeEach, describe, expect, it } from "vitest";
import {
  acpSessionToChatSession,
  mergeAcpSessionPage,
} from "@/features/chat/lib/acpSessionMapping";
import type { AcpSessionInfo } from "@/shared/api/acp";

function listedSession(
  overrides: Partial<AcpSessionInfo> = {},
): AcpSessionInfo {
  return {
    sessionId: "s1",
    title: "Chat",
    updatedAt: "2026-06-09T00:00:00.000Z",
    createdAt: "2026-06-09T00:00:00.000Z",
    lastMessageAt: null,
    archivedAt: null,
    userSetName: false,
    messageCount: 2,
    subtitle: null,
    workingDir: null,
    providerId: null,
    modelId: null,
    personaId: null,
    ...overrides,
  };
}

function emptyState() {
  return { sessions: [], archiveMutationBySessionId: {} };
}

describe("acpSessionToChatSession", () => {
  // The renderer's only cheap answer to "is this session's last reply still
  // being written?" — dropping it meant every ordinary load left the last
  // bubble in progress.
  it("keeps the run the host reported for the session", () => {
    expect(
      acpSessionToChatSession(listedSession({ activeRunId: "run-1" }))
        .activeRunId,
    ).toBe("run-1");
    expect(
      acpSessionToChatSession(listedSession({ activeRunId: null })).activeRunId,
    ).toBeNull();
  });

  it("says nothing when the host reported no run state at all", () => {
    const mapped = acpSessionToChatSession(listedSession());

    expect("activeRunId" in mapped).toBe(false);
  });

  it("carries the run state of every listed session through a page merge", () => {
    const merged = mergeAcpSessionPage(
      emptyState(),
      {
        sessions: [
          listedSession({ sessionId: "running", activeRunId: "run-1" }),
          listedSession({ sessionId: "settled", activeRunId: null }),
        ],
        nextCursor: null,
      },
      null,
    );

    expect(
      merged.sessions.find((session) => session.id === "running")?.activeRunId,
    ).toBe("run-1");
    expect(
      merged.sessions.find((session) => session.id === "settled")?.activeRunId,
    ).toBeNull();
  });
});

// `loadSessions` runs at startup, every 60 s and on every window focus. It used
// to rebuild every session object (and the array) even when the host reported
// exactly what the store already had, re-rendering every list subscriber.
describe("mergeAcpSessionPage identity", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  function page(sessions: AcpSessionInfo[], nextCursor: string | null = null) {
    return { sessions, nextCursor };
  }

  it("returns the very same sessions and array when nothing changed", () => {
    const listed = [
      listedSession({ sessionId: "s1" }),
      listedSession({ sessionId: "s2", updatedAt: "2026-06-10T00:00:00.000Z" }),
    ];
    const first = mergeAcpSessionPage(emptyState(), page(listed), null);

    const second = mergeAcpSessionPage(
      {
        sessions: first.sessions,
        archiveMutationBySessionId: first.archiveMutationBySessionId,
      },
      page(listed),
      null,
    );

    expect(second.sessions).toBe(first.sessions);
    expect(second.sessions[0]).toBe(first.sessions[0]);
    expect(second.sessions[1]).toBe(first.sessions[1]);
  });

  it("keeps a session object whose workspace attachments were only re-normalized", () => {
    window.localStorage.setItem(
      "distill:chat-workspace-metadata",
      JSON.stringify({
        s1: {
          workspaceAttachments: [
            {
              id: "ws-1",
              path: "C:\\repo",
              kind: "directory",
              source: "selected",
              branch: null,
              usedByAgent: false,
            },
          ],
          activeWorkspaceId: "ws-1",
        },
      }),
    );
    const listed = [listedSession({ sessionId: "s1", workingDir: "C:\\repo" })];
    const first = mergeAcpSessionPage(emptyState(), page(listed), null);
    expect(first.sessions[0]?.workspaceAttachments).toHaveLength(1);

    const second = mergeAcpSessionPage(
      {
        sessions: first.sessions,
        archiveMutationBySessionId: first.archiveMutationBySessionId,
      },
      page(listed),
      null,
    );

    expect(second.sessions).toBe(first.sessions);
  });

  it("replaces the row the host actually changed, and only that one", () => {
    const first = mergeAcpSessionPage(
      emptyState(),
      page([
        listedSession({ sessionId: "s1" }),
        listedSession({ sessionId: "s2" }),
      ]),
      null,
    );
    const before = first.sessions;

    const second = mergeAcpSessionPage(
      {
        sessions: before,
        archiveMutationBySessionId: first.archiveMutationBySessionId,
      },
      page([
        listedSession({ sessionId: "s1", title: "Renamed" }),
        listedSession({ sessionId: "s2" }),
      ]),
      null,
    );

    expect(second.sessions).not.toBe(before);
    const renamed = second.sessions.find((session) => session.id === "s1");
    const untouched = second.sessions.find((session) => session.id === "s2");
    expect(renamed?.title).toBe("Renamed");
    expect(untouched).toBe(before.find((session) => session.id === "s2"));
  });
});
