import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteUserAvatar,
  cachedAssetToMedia,
  getCachedAvatarForRef,
  getCachedAvatarsForRefs,
  importAgentAvatarFile,
} from "./avatars";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const cachedUserAvatar = {
  catalogVersion: "user-generated",
  collectionId: "generated-gloopies",
  asset: {
    id: "gloopie-1",
    path: "/tmp/goose/user-avatars/media/gloopie-1.png",
    mimeType: "image/png",
  },
};

describe("avatars api", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("resolves cached video posters as a still image", () => {
    expect(
      cachedAssetToMedia({
        path: "/tmp/avatar.mp4",
        mimeType: "video/mp4",
        posterPath: "/tmp/avatar.png",
      }),
    ).toEqual({
      src: "asset:///tmp/avatar.png",
      mediaType: "image",
    });
  });

  it("deletes generated avatar media through the native command", async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    invokeMock.mockResolvedValueOnce(undefined);

    await deleteUserAvatar("user-avatar:gloopie-1");

    expect(invokeMock).toHaveBeenCalledWith("delete_user_avatar", {
      avatarRef: "user-avatar:gloopie-1",
    });
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("imports an agent avatar image through the native command", async () => {
    invokeMock.mockResolvedValueOnce("user-avatar:agent-1");

    await expect(
      importAgentAvatarFile({
        agentPath: "/Users/x/.agents/agents/helper.md",
        sourcePath: "/Users/x/Pictures/avatar.gif",
      }),
    ).resolves.toBe("user-avatar:agent-1");

    expect(invokeMock).toHaveBeenCalledWith("import_agent_avatar_file", {
      agentPath: "/Users/x/.agents/agents/helper.md",
      sourcePath: "/Users/x/Pictures/avatar.gif",
    });
  });

  it("resolves saved refs with the batched cached-only command", async () => {
    invokeMock.mockResolvedValueOnce({
      "user-avatar:gloopie-1": cachedUserAvatar,
    });
    await expect(
      getCachedAvatarForRef({ avatarRef: "user-avatar:gloopie-1" }),
    ).resolves.toMatchObject({
      catalogVersion: "user-generated",
      collectionId: "generated-gloopies",
    });

    expect(invokeMock).toHaveBeenCalledWith("get_cached_avatars_for_refs", {
      avatarRefs: ["user-avatar:gloopie-1"],
    });
  });

  it("coalesces same-tick cached avatar lookups", async () => {
    invokeMock.mockResolvedValueOnce({
      "user-avatar:gloopie-1": cachedUserAvatar,
      "app-avatar:gloopy-2": null,
    });

    const first = getCachedAvatarForRef({ avatarRef: "user-avatar:gloopie-1" });
    const second = getCachedAvatarForRef({ avatarRef: "app-avatar:gloopy-2" });

    await expect(first).resolves.toMatchObject({
      collectionId: "generated-gloopies",
    });
    // A ref from the retired CDN library resolves to nothing, not an error.
    await expect(second).resolves.toBeNull();
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("get_cached_avatars_for_refs", {
      avatarRefs: ["user-avatar:gloopie-1", "app-avatar:gloopy-2"],
    });
  });

  it("rejects every caller in a batch when the lookup fails", async () => {
    invokeMock.mockRejectedValueOnce("Failed to resolve app data directory");

    const first = getCachedAvatarForRef({ avatarRef: "user-avatar:gloopie-1" });
    const second = getCachedAvatarForRef({ avatarRef: "agent-avatar:scout" });

    await expect(first).rejects.toBe("Failed to resolve app data directory");
    await expect(second).rejects.toBe("Failed to resolve app data directory");
  });

  it("resolves an explicit cached avatar batch", async () => {
    invokeMock.mockResolvedValueOnce({
      "user-avatar:gloopie-1": cachedUserAvatar,
    });

    await expect(
      getCachedAvatarsForRefs({ avatarRefs: ["user-avatar:gloopie-1"] }),
    ).resolves.toHaveProperty("user-avatar:gloopie-1");
    expect(invokeMock).toHaveBeenCalledWith("get_cached_avatars_for_refs", {
      avatarRefs: ["user-avatar:gloopie-1"],
    });
  });

  it("skips the native call for an empty batch", async () => {
    const result = await getCachedAvatarsForRefs({ avatarRefs: [] });

    expect(result).toEqual({});
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
