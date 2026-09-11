import { invoke } from "@tauri-apps/api/core";

/**
 * Deletes the avatar and project artwork caches that earlier builds
 * downloaded from Block's CDN. Nothing refills them; this only frees the disk
 * space an older install left behind.
 */
export async function clearLocalMediaCaches(): Promise<void> {
  await invoke("clear_local_media_caches");
}
