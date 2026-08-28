/**
 * A project's own documents, inside the project folder.
 *
 * The sibling of `distillStore`, and the split between them is the point. The
 * global root holds what belongs to the operator — their agents, their skills,
 * their memory, the conductor's state — which is the right home for almost all
 * of it and the wrong home for the part that is about one piece of work. An
 * instruction that only makes sense inside a repository, and an agent written
 * for it, should move when that folder moves and should not follow the
 * operator into an unrelated project.
 *
 * Same contract as the global store: the renderer names a relative path and
 * gets text, and where that can land — always inside `<project>/.distill` — is
 * decided in Rust (`commands/project_store.rs`). Two extensions instead of
 * one: `.json` for state and `.md` for the things a person is meant to read
 * and edit, which is most of what a project override actually is.
 *
 * Outside the desktop app there is no project folder to reach, and every call
 * is a quiet no-op rather than an error: a browser preview has no repository.
 */

import { invoke } from "@tauri-apps/api/core";

import { isDesktopRuntime } from "./distillStore";

/** The folder these documents live in, inside the project. */
export const PROJECT_STORE_DIR = ".distill";

export async function readProjectDocument(
  projectRoot: string,
  path: string,
): Promise<string | null> {
  if (!isDesktopRuntime() || !projectRoot) return null;
  return invoke<string | null>("read_project_document", {
    projectRoot,
    path,
  });
}

/**
 * Writes one document, atomically.
 *
 * The first write into a project also arranges for git to ignore what agent
 * tools leave there — `.git/info/exclude`, never `.gitignore`, because the
 * second is a tracked file belonging to whoever owns the repository.
 */
export async function writeProjectDocument(
  projectRoot: string,
  path: string,
  contents: string,
): Promise<void> {
  if (!isDesktopRuntime() || !projectRoot) return;
  await invoke("write_project_document", { projectRoot, path, contents });
}

/** File names directly inside one of a project's store folders, sorted. */
export async function listProjectDocuments(
  projectRoot: string,
  path: string,
): Promise<string[]> {
  if (!isDesktopRuntime() || !projectRoot) return [];
  return invoke<string[]>("list_project_documents", { projectRoot, path });
}
