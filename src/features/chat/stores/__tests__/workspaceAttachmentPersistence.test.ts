import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceAttachmentIdForPath } from "@/features/chat/lib/workspaceAttachments";
import {
  CHAT_WORKSPACE_METADATA_CHANGED_EVENT,
  CHAT_WORKSPACE_METADATA_STORAGE_KEY,
  loadPersistedChatWorkspaceMetadata,
  type PersistedChatWorkspaceMetadata,
  persistChatWorkspaceMetadata,
} from "../workspaceAttachmentPersistence";

function metadata(usedByAgent: boolean): PersistedChatWorkspaceMetadata {
  return {
    workspaceAttachments: [
      {
        id: workspaceAttachmentIdForPath("/tmp/main"),
        path: "/tmp/main",
        kind: "git-main-worktree",
        source: "selected",
        branch: "main",
        usedByAgent,
      },
    ],
    activeWorkspaceId: null,
    workingDir: "/tmp/main",
  };
}

describe("persistChatWorkspaceMetadata", () => {
  let setItem: ReturnType<typeof vi.spyOn>;
  let removeItem: ReturnType<typeof vi.spyOn>;
  const changed = vi.fn();

  beforeEach(() => {
    window.localStorage.removeItem(CHAT_WORKSPACE_METADATA_STORAGE_KEY);
    setItem = vi.spyOn(Storage.prototype, "setItem");
    removeItem = vi.spyOn(Storage.prototype, "removeItem");
    changed.mockClear();
    window.addEventListener(CHAT_WORKSPACE_METADATA_CHANGED_EVENT, changed);
  });

  afterEach(() => {
    window.removeEventListener(CHAT_WORKSPACE_METADATA_CHANGED_EVENT, changed);
    vi.restoreAllMocks();
  });

  it("does not rewrite the blob or announce a change when nothing changed", () => {
    persistChatWorkspaceMetadata("s1", metadata(true));
    persistChatWorkspaceMetadata("s2", metadata(false));
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(2);

    // Equal content, freshly built, as every send builds it.
    persistChatWorkspaceMetadata("s1", metadata(true));

    expect(setItem).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(loadPersistedChatWorkspaceMetadata("s1")).toEqual(metadata(true));
  });

  it("still writes a real change and names the session that changed", () => {
    persistChatWorkspaceMetadata("s1", metadata(false));
    persistChatWorkspaceMetadata("s1", metadata(true));

    expect(setItem).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(
      (changed.mock.calls[1]?.[0] as CustomEvent<{ sessionIds: string[] }>)
        .detail.sessionIds,
    ).toEqual(["s1"]);
    expect(loadPersistedChatWorkspaceMetadata("s1")).toEqual(metadata(true));
  });

  it("does nothing when clearing a session that has no stored entry", () => {
    persistChatWorkspaceMetadata("s1", metadata(true));
    setItem.mockClear();
    changed.mockClear();

    persistChatWorkspaceMetadata("s2", {
      workspaceAttachments: [],
      activeWorkspaceId: null,
      workingDir: null,
    });

    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(loadPersistedChatWorkspaceMetadata("s1")).toEqual(metadata(true));
  });
});
