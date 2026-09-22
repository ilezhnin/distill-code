/**
 * The app's own documents, in the operator's Distill folder.
 *
 * The renderer names a relative path and gets text back. Where that lands —
 * and the fact that it cannot land anywhere else — is decided in Rust
 * (`commands/distill_store.rs`). JSON documents are the writable store;
 * Markdown instruction files are read-only through `readDistillInstructions`.
 *
 * Outside the desktop app there is no folder at all: unit tests and any
 * browser preview fall back to `localStorage` for JSON documents, and
 * instruction reads answer with null for every path. That fallback is why
 * the store layer can be written once and used the same way everywhere.
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

export async function readDistillInstructions(
  paths: string[],
): Promise<Record<string, string | null>> {
  if (!isDesktopRuntime()) {
    return Object.fromEntries(paths.map((path) => [path, null]));
  }
  return invokeWithStartupRetry<Record<string, string | null>>(
    "read_distill_instructions",
    { paths },
  );
}

export async function writeDistillDocument(
  path: string,
  contents: string,
): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("write_distill_document", { path, contents });
}
