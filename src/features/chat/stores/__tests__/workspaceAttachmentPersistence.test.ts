import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_WORKSPACE_METADATA_STORAGE_KEY,
  loadPersistedChatWorkspaceMetadata,
  persistChatWorkspaceMetadata,
} from "../workspaceAttachmentPersistence";

function seedBlob(sessionIds: string[]): void {
  const blob = Object.fromEntries(
    sessionIds.map((sessionId) => [
      sessionId,
      {
        workspaceAttachments: [
          {
            id: `ws-${sessionId}`,
            path: `C:\\repos\\${sessionId}`,
            kind: "directory",
            source: "selected",
            branch: null,
            usedByAgent: false,
          },
        ],
        activeWorkspaceId: `ws-${sessionId}`,
      },
    ]),
  );
  window.localStorage.setItem(
    CHAT_WORKSPACE_METADATA_STORAGE_KEY,
    JSON.stringify(blob),
  );
}

describe("loadPersistedChatWorkspaceMetadata", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  // The session-list refresh asks for one session's entry at a time, 200 times
  // per page, every 60 s and on focus. Parsing and normalizing the whole blob
  // for each of those lookups was O(sessions x blob).
  it("parses the blob once while it is unchanged", () => {
    seedBlob(["s1", "s2", "s3"]);
    const parse = vi.spyOn(JSON, "parse");

    const first = loadPersistedChatWorkspaceMetadata("s1");
    const again = loadPersistedChatWorkspaceMetadata("s1");
    loadPersistedChatWorkspaceMetadata("s2");
    loadPersistedChatWorkspaceMetadata("s3");

    expect(first).not.toBeNull();
    expect(again).toBe(first);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("re-reads after a write in this window", () => {
    seedBlob(["s1"]);
    expect(loadPersistedChatWorkspaceMetadata("s1")?.workingDir).toBeNull();

    persistChatWorkspaceMetadata("s1", {
      workspaceAttachments: [
        {
          id: "ws-s1",
          path: "C:\\repos\\s1",
          kind: "directory",
          source: "selected",
          branch: null,
          usedByAgent: false,
        },
      ],
      activeWorkspaceId: "ws-s1",
      workingDir: "C:\\repos\\s1",
    });

    expect(loadPersistedChatWorkspaceMetadata("s1")?.workingDir).toBe(
      "C:\\repos\\s1",
    );
  });

  it("re-reads after another window replaced the blob", () => {
    seedBlob(["s1"]);
    expect(loadPersistedChatWorkspaceMetadata("s1")).not.toBeNull();

    seedBlob(["s2"]);

    expect(loadPersistedChatWorkspaceMetadata("s1")).toBeNull();
    expect(loadPersistedChatWorkspaceMetadata("s2")).not.toBeNull();
  });
});
