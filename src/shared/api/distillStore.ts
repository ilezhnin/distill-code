/**
 * The app's own documents, in the operator's Distill folder.
 *
 * Four commands, one idea: the renderer names a relative path and gets JSON
 * text. Where that lands — and the fact that it cannot land anywhere else —
 * is decided in Rust (`commands/distill_store.rs`).
 *
 * Outside the desktop app there is no folder at all: unit tests and any
 * browser preview fall back to `localStorage`, which is what these documents
 * used to be. That fallback is why the store layer can be written once and
 * used the same way everywhere.
 */

import { invoke } from "@tauri-apps/api/core";

export interface DistillRootInfo {
  root: string;
  /** True when `DISTILL_ROOT` forced it, so the setting is not in charge. */
  forcedByEnvironment: boolean;
  /**
   * True when chats, projects and settings live in the root as well.
   *
   * False on a machine that already had goose data when this landed: moving
   * it without being asked would open the app with an empty history and no
   * explanation, so it stays where it is until the operator picks a folder.
   */
  holdsEverything: boolean;
  /** Where that older data still is, when it has not moved. */
  legacyDataDir: string | null;
}

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export async function getDistillRoot(): Promise<DistillRootInfo | null> {
  if (!isDesktopRuntime()) return null;
  try {
    return await invoke<DistillRootInfo>("get_distill_root");
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
  return invoke<string | null>("read_distill_document", { path });
}

export async function writeDistillDocument(
  path: string,
  contents: string,
): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("write_distill_document", { path, contents });
}
