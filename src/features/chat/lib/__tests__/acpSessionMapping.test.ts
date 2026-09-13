import { describe, expect, it } from "vitest";
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
