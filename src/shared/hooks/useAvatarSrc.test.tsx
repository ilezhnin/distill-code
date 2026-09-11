import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCachedAvatarForRef } from "@/shared/api/avatars";
import {
  useAvatarImage,
  useAvatarMediaState,
  useAvatarSrc,
} from "./useAvatarSrc";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
  invoke: vi.fn(),
}));

vi.mock("@/shared/api/avatars", () => ({
  avatarCachedRefQueryKey: (avatarRef: string) => [
    "avatars",
    "cached-ref",
    avatarRef,
  ],
  cachedAssetToMedia: (asset: {
    path: string;
    mimeType: string;
    alphaMode?: "stacked";
  }) => ({
    src: `asset://${asset.path}`,
    mediaType: asset.mimeType.startsWith("video/") ? "video" : "image",
    ...(asset.alphaMode ? { alphaMode: asset.alphaMode } : {}),
  }),
  getCachedAvatarForRef: vi.fn(),
}));

const getCachedAvatarForRefMock = vi.mocked(getCachedAvatarForRef);

const scoutAvatar = {
  catalogVersion: "bundled-agent-avatars",
  collectionId: "agents",
  asset: {
    id: "scout",
    path: "/tmp/home/.agents/agents/.avatars/scout.png",
    mimeType: "image/png",
  },
};

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function createWrapper(queryClient = createQueryClient()) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("useAvatarSrc", () => {
  beforeEach(() => {
    getCachedAvatarForRefMock.mockReset();
  });

  it("keeps URL avatar behavior unchanged", () => {
    const mediaState = renderHook(
      () => useAvatarMediaState("https://example.test/scout.png"),
      { wrapper: createWrapper() },
    );
    const avatarSrc = renderHook(() =>
      useAvatarSrc("https://example.test/scout.png"),
    );

    expect(avatarSrc.result.current).toBe("https://example.test/scout.png");
    expect(mediaState.result.current).toMatchObject({
      media: {
        src: "https://example.test/scout.png",
        mediaType: "image",
      },
      loading: false,
      unavailable: false,
    });
    expect(getCachedAvatarForRefMock).not.toHaveBeenCalled();
  });

  it("resolves agent-avatar refs with cached-only lookup", async () => {
    getCachedAvatarForRefMock.mockResolvedValueOnce(scoutAvatar);

    const { result } = renderHook(
      () => useAvatarMediaState("agent-avatar:scout"),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.media).toEqual({
        src: "asset:///tmp/home/.agents/agents/.avatars/scout.png",
        mediaType: "image",
      });
    });

    expect(getCachedAvatarForRefMock).toHaveBeenCalledWith({
      avatarRef: "agent-avatar:scout",
    });
  });

  it("resolves user-avatar refs with cached-only lookup", async () => {
    getCachedAvatarForRefMock.mockResolvedValueOnce({
      catalogVersion: "user-generated",
      collectionId: "generated-gloopies",
      asset: {
        id: "gloopie-1",
        path: "/tmp/goose/user-avatars/gloopie-1.webm",
        mimeType: "video/webm",
        alphaMode: "stacked",
      },
    });

    const { result } = renderHook(
      () => useAvatarMediaState("user-avatar:gloopie-1"),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.media).toEqual({
        src: "asset:///tmp/goose/user-avatars/gloopie-1.webm",
        mediaType: "video",
        alphaMode: "stacked",
      });
    });

    expect(getCachedAvatarForRefMock).toHaveBeenCalledWith({
      avatarRef: "user-avatar:gloopie-1",
    });
  });

  it("marks a user avatar whose files are gone unavailable", async () => {
    getCachedAvatarForRefMock.mockResolvedValueOnce(null);

    const { result } = renderHook(
      () => useAvatarMediaState("user-avatar:gloopie-1"),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.unavailable).toBe(true);
    });

    expect(result.current.media).toBeUndefined();
    expect(getCachedAvatarForRefMock).toHaveBeenCalledTimes(1);
  });

  it("reports loading, not unavailable, while re-checking a cached null on remount", async () => {
    const queryClient = createQueryClient();
    const wrapper = createWrapper(queryClient);

    getCachedAvatarForRefMock.mockResolvedValueOnce(null);
    const first = renderHook(
      () => useAvatarMediaState("user-avatar:gloopie-1"),
      { wrapper },
    );
    await waitFor(() => {
      expect(first.result.current.unavailable).toBe(true);
    });
    first.unmount();

    let resolveRecheck: (value: null) => void = () => {};
    getCachedAvatarForRefMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRecheck = resolve;
        }),
    );

    const second = renderHook(
      () => useAvatarMediaState("user-avatar:gloopie-1"),
      { wrapper },
    );

    await waitFor(() => {
      expect(getCachedAvatarForRefMock).toHaveBeenCalledTimes(2);
    });
    expect(second.result.current.loading).toBe(true);
    expect(second.result.current.unavailable).toBe(false);

    await act(async () => {
      resolveRecheck(null);
    });
    await waitFor(() => {
      expect(second.result.current.unavailable).toBe(true);
    });
    expect(second.result.current.loading).toBe(false);
  });

  it("treats persisted app-avatar refs as missing without a lookup", () => {
    const { result } = renderHook(
      () => ({
        image: useAvatarImage("app-avatar:gloopy-1"),
        mediaState: useAvatarMediaState("app-avatar:gloopy-1"),
      }),
      { wrapper: createWrapper() },
    );

    expect(result.current.image).toBeUndefined();
    expect(result.current.mediaState).toMatchObject({
      media: undefined,
      loading: false,
      unavailable: false,
    });
    expect(getCachedAvatarForRefMock).not.toHaveBeenCalled();
  });

  it("ignores malformed refs without cached lookup", () => {
    const { result } = renderHook(
      () => useAvatarMediaState("user-avatar:../secret"),
      { wrapper: createWrapper() },
    );

    expect(result.current).toMatchObject({
      media: undefined,
      loading: false,
      unavailable: false,
    });
    expect(getCachedAvatarForRefMock).not.toHaveBeenCalled();
  });

  it("dedupes repeated refs through React Query", async () => {
    getCachedAvatarForRefMock.mockResolvedValue(scoutAvatar);

    const { result } = renderHook(
      () => [
        useAvatarMediaState("agent-avatar:scout"),
        useAvatarMediaState("agent-avatar:scout"),
      ],
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current[0].media?.src).toBe(
        "asset:///tmp/home/.agents/agents/.avatars/scout.png",
      );
      expect(result.current[1].media?.src).toBe(
        "asset:///tmp/home/.agents/agents/.avatars/scout.png",
      );
    });

    expect(getCachedAvatarForRefMock).toHaveBeenCalledTimes(1);
  });

  it("passes remote image URLs through as the static image", () => {
    const { result } = renderHook(() =>
      useAvatarImage("https://example.test/scout.png"),
    );

    expect(result.current).toBe("https://example.test/scout.png");
  });
});
