import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  mediaTypeFromMimeType,
  type CachedAvatar,
  type ResolvedAvatarMedia,
} from "@/shared/avatars/catalog";

type CachedAvatarBatchResult = Record<string, CachedAvatar | null | undefined>;

interface PendingCachedAvatarRequest {
  resolve: (avatar: CachedAvatar | null) => void;
  reject: (error: unknown) => void;
}

let pendingCachedAvatarRequests = new Map<
  string,
  PendingCachedAvatarRequest[]
>();
let cachedAvatarBatchScheduled = false;

function scheduleCachedAvatarBatch(): void {
  if (cachedAvatarBatchScheduled) {
    return;
  }

  cachedAvatarBatchScheduled = true;
  queueMicrotask(() => {
    const pending = pendingCachedAvatarRequests;
    pendingCachedAvatarRequests = new Map();
    cachedAvatarBatchScheduled = false;

    void getCachedAvatarsForRefs({
      avatarRefs: [...pending.keys()],
    })
      .then((avatarsByRef) => {
        for (const [avatarRef, requests] of pending) {
          const avatar = avatarsByRef[avatarRef] ?? null;
          for (const request of requests) {
            request.resolve(avatar);
          }
        }
      })
      .catch((error: unknown) => {
        for (const requests of pending.values()) {
          for (const request of requests) {
            request.reject(error);
          }
        }
      });
  });
}

/**
 * Resolves `user-avatar:` and `agent-avatar:` refs to files on disk. Any other
 * ref (a persisted `app-avatar:` ref included) comes back as `null`.
 */
export async function getCachedAvatarsForRefs({
  avatarRefs,
}: {
  avatarRefs: string[];
}): Promise<CachedAvatarBatchResult> {
  if (avatarRefs.length === 0) {
    return {};
  }

  return invoke<CachedAvatarBatchResult>("get_cached_avatars_for_refs", {
    avatarRefs,
  });
}

export async function importUserAvatarDataUrl({
  dataUrl,
  alphaMode,
  posterDataUrl,
}: {
  dataUrl: string;
  alphaMode?: "stacked";
  posterDataUrl?: string;
}): Promise<string> {
  return invoke<string>("import_user_avatar_data_url", {
    dataUrl,
    alphaMode,
    posterDataUrl,
  });
}

export async function importAgentAvatarFile({
  agentPath,
  sourcePath,
}: {
  agentPath: string;
  sourcePath: string;
}): Promise<string> {
  return invoke<string>("import_agent_avatar_file", {
    agentPath,
    sourcePath,
  });
}

export async function deleteUserAvatar(avatarRef: string): Promise<void> {
  if (!window.__TAURI_INTERNALS__) {
    return;
  }
  await invoke("delete_user_avatar", { avatarRef });
}

export async function getCachedAvatarForRef({
  avatarRef,
}: {
  avatarRef: string;
}): Promise<CachedAvatar | null> {
  return new Promise<CachedAvatar | null>((resolve, reject) => {
    const requests = pendingCachedAvatarRequests.get(avatarRef) ?? [];
    requests.push({ resolve, reject });
    pendingCachedAvatarRequests.set(avatarRef, requests);
    scheduleCachedAvatarBatch();
  });
}

export function cachedAssetToMedia(asset: {
  path: string;
  mimeType: string;
  alphaMode?: ResolvedAvatarMedia["alphaMode"];
  posterPath?: string;
}): ResolvedAvatarMedia {
  if (asset.posterPath) {
    return {
      src: convertFileSrc(asset.posterPath, "asset"),
      mediaType: "image",
    };
  }
  return {
    src: convertFileSrc(asset.path, "asset"),
    mediaType: mediaTypeFromMimeType(asset.mimeType),
  };
}

export function avatarCachedRefQueryKey(avatarRef: string) {
  return ["avatars", "cached-ref", avatarRef] as const;
}
