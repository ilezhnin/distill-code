import { useCallback, useContext, useMemo } from "react";
import {
  QueryClient,
  QueryClientContext,
  useQuery,
} from "@tanstack/react-query";
import {
  avatarCachedRefQueryKey,
  cachedAssetToMedia,
  getCachedAvatarForRef,
} from "@/shared/api/avatars";
import { isAgentAvatarRef, isUserAvatarRef } from "@/shared/avatars/catalog";
import { resolveAvatarMedia, resolveAvatarSrc } from "@/shared/lib/avatarUrl";
import type { Avatar } from "@/shared/types/agents";
import type { ResolvedAvatarMedia } from "@/shared/avatars/catalog";

export interface AvatarMediaState {
  media: ResolvedAvatarMedia | undefined;
  loading: boolean;
  unavailable: boolean;
  retry: () => void;
}

/**
 * React hook that resolves an Avatar to a displayable image URL.
 */
export function useAvatarSrc(
  avatar: Avatar | null | undefined,
): string | undefined {
  return useMemo(() => resolveAvatarSrc(avatar), [avatar]);
}

/**
 * React hook that resolves an Avatar to displayable image media.
 */
export function useAvatarMedia(avatar: Avatar | null | undefined) {
  return useAvatarMediaState(avatar).media;
}

/**
 * React hook that resolves an Avatar to a static image URL. Remote URLs and
 * PNG data URLs pass through; app-managed refs (`user-avatar:`,
 * `agent-avatar:`) resolve through `useAvatarMedia` instead, and a persisted
 * `app-avatar:` ref from the retired CDN library resolves to nothing.
 */
export function useAvatarImage(
  avatar: Avatar | null | undefined,
): string | undefined {
  return useAvatarSrc(avatar);
}

// Only used when a component mounts without a QueryClientProvider (some
// tests do); `enabled` is false in that case so it never fetches — it just
// keeps the unconditional useQuery call legal.
let fallbackQueryClient: QueryClient | null = null;
function getFallbackQueryClient(): QueryClient {
  fallbackQueryClient ??= new QueryClient();
  return fallbackQueryClient;
}

export function useAvatarMediaState(
  avatar: Avatar | null | undefined,
): AvatarMediaState {
  const queryClient = useContext(QueryClientContext);
  const directMedia = useMemo(() => resolveAvatarMedia(avatar), [avatar]);
  const avatarRef = typeof avatar === "string" ? avatar.trim() : "";
  // User and bundled agent avatars are files on disk, looked up by ref. A
  // persisted `app-avatar:` ref has nothing behind it anymore, so it skips
  // the lookup and renders as a missing avatar.
  const shouldLoadCachedAvatar =
    !directMedia && (isUserAvatarRef(avatarRef) || isAgentAvatarRef(avatarRef));
  const enabled = shouldLoadCachedAvatar && Boolean(queryClient);

  // Reactive observer on the shared per-ref cache entry, so every tile
  // showing the same avatar shares one lookup.
  const cachedAvatarQuery = useQuery(
    {
      queryKey: avatarCachedRefQueryKey(avatarRef),
      queryFn: async () => {
        try {
          return await getCachedAvatarForRef({ avatarRef });
        } catch (error) {
          console.warn("Failed to resolve avatar asset:", error);
          throw error;
        }
      },
      enabled,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
    queryClient ?? getFallbackQueryClient(),
  );

  const retry = useCallback(() => {
    if (!queryClient || !shouldLoadCachedAvatar) {
      return;
    }
    // Reset (not invalidate) so the tile blanks and shows its loading state
    // while the lookup re-runs.
    void queryClient.resetQueries({
      queryKey: avatarCachedRefQueryKey(avatarRef),
    });
  }, [avatarRef, queryClient, shouldLoadCachedAvatar]);

  const remoteMedia = useMemo(
    () =>
      cachedAvatarQuery.data
        ? cachedAssetToMedia(cachedAvatarQuery.data.asset)
        : undefined,
    [cachedAvatarQuery.data],
  );

  // A cached `null` ("not cached yet") is a valid success value, so on a
  // remount within gcTime the query starts at data === null while a
  // background refetch re-checks the ref. Report that re-check as loading
  // rather than unavailable so the tile keeps its loading state until the
  // lookup settles, as the pre-query implementation did.
  const recheckingWithoutData =
    cachedAvatarQuery.isFetching && !cachedAvatarQuery.data;

  return {
    media: directMedia ?? remoteMedia,
    loading: enabled && (cachedAvatarQuery.isPending || recheckingWithoutData),
    unavailable:
      (shouldLoadCachedAvatar && !queryClient) ||
      (enabled &&
        !recheckingWithoutData &&
        (cachedAvatarQuery.data === null || cachedAvatarQuery.isError)),
    retry,
  };
}
