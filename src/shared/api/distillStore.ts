/**
 * JSON document storage under the configured Distill data root.
 * Rust resolves and bounds document paths. Browser previews use localStorage
 * through the higher-level document adapters.
 */

import { invoke } from "@tauri-apps/api/core";
import { invokeWithStartupRetry } from "@/shared/api/invokeWithStartupRetry";

export interface DistillRootInfo {
  root: string;
  /** True when `DISTILL_ROOT` forced it, so the setting is not in charge. */
  forcedByEnvironment: boolean;
}

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export async function getDistillRoot(): Promise<DistillRootInfo | null> {
  if (!isDesktopRuntime()) return null;
  try {
    // Same startup window as the document reads: the first chat can mount
    // before `app.manage` has registered DistillRootState, and a bare
    // invoke that loses that race would look like "there is no root".
    return await invokeWithStartupRetry<DistillRootInfo>("get_distill_root");
  } catch (error) {
    console.error("Failed to read the Distill root:", error);
    return null;
  }
}

/** Records a new root. Takes effect on the next start; nothing is moved. */
export async function setDistillRoot(path: string): Promise<void> {
  await invoke("set_distill_root", { path });
}

export async function readDistillDocument(
  path: string,
): Promise<string | null> {
  if (!isDesktopRuntime()) return null;
  // Startup hydration can race the backend's setup; a read that fails there
  // leaves its store unhydrated for the whole run, so ride out that window.
  return invokeWithStartupRetry<string | null>("read_distill_document", {
    path,
  });
}

export async function writeDistillDocument(
  path: string,
  contents: string,
): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("write_distill_document", { path, contents });
}
