/**
 * JSON document storage under the configured Flock data root.
 * Rust resolves and bounds document paths. Browser previews use localStorage
 * through the higher-level document adapters.
 */

import { invoke } from "@tauri-apps/api/core";
import { invokeWithStartupRetry } from "@/shared/api/invokeWithStartupRetry";

export interface FlockRootInfo {
  root: string;
  /** True when `FLOCK_ROOT` forced it, so the setting is not in charge. */
  forcedByEnvironment: boolean;
}

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export async function getFlockRoot(): Promise<FlockRootInfo | null> {
  if (!isDesktopRuntime()) return null;
  try {
    // Same startup window as the document reads: the first chat can mount
    // before `app.manage` has registered FlockRootState, and a bare
    // invoke that loses that race would look like "there is no root".
    return await invokeWithStartupRetry<FlockRootInfo>("get_flock_root");
  } catch (error) {
    console.error("Failed to read the Flock root:", error);
    return null;
  }
}

/** Records a new root. Takes effect on the next start; nothing is moved. */
export async function setFlockRoot(path: string): Promise<void> {
  await invoke("set_flock_root", { path });
}

export async function readFlockDocument(path: string): Promise<string | null> {
  if (!isDesktopRuntime()) return null;
  // Startup hydration can race the backend's setup; a read that fails there
  // leaves its store unhydrated for the whole run, so ride out that window.
  return invokeWithStartupRetry<string | null>("read_flock_document", {
    path,
  });
}

export async function writeFlockDocument(
  path: string,
  contents: string,
): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("write_flock_document", { path, contents });
}
