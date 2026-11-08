import { getPreferenceStorage } from "@/shared/preferences/rootSettings";
import { getFlockRoot } from "@/shared/api/flockStore";
import { resolvePath } from "@/shared/api/pathResolver";
import { ensureDirectory } from "@/shared/api/system";

export const ARTIFACT_ROOT_STORAGE_KEY = "flock:artifact-root-path";
export const ARTIFACT_ROOT_CHANGED_EVENT = "flock:artifact-root-path-changed";
/** Generated files land under the Flock folder, beside projects and memory. */
export const DEFAULT_ARTIFACT_ROOT_FOLDER_NAME = "artifacts";
const FALLBACK_FLOCK_ROOT_FOLDER_NAME = ".flock";

export interface SessionArtifactLocationOptions {
  artifactRootOverride?: string | null;
}

function trimValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function hasTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(
      (window as typeof window & { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__,
    )
  );
}

const ARTIFACT_ROOT_PLACEHOLDER = `~/${FALLBACK_FLOCK_ROOT_FOLDER_NAME}/${DEFAULT_ARTIFACT_ROOT_FOLDER_NAME}`;

/**
 * The default folder as the host last resolved it under the running Flock
 * root. A new chat is drawn on a folder before the host answers; once one
 * answer is in, it is drawn on this one rather than on the placeholder, which
 * names the wrong folder under a custom root, an isolated test root or an
 * upgraded `~/.distill`.
 */
let lastResolvedDefaultArtifactRoot: string | null = null;

function fallbackDefaultArtifactRootPath(): string {
  return ARTIFACT_ROOT_PLACEHOLDER;
}

/**
 * True for the placeholder a chat is drawn with before the default folder
 * has resolved. It stands for the default folder, not a folder of its own:
 * the host expands `~` against the user's home, outside a custom Flock root.
 */
export function isArtifactRootPlaceholder(
  path: string | null | undefined,
): boolean {
  return trimValue(path) === ARTIFACT_ROOT_PLACEHOLDER;
}

export async function defaultArtifactRootPath(): Promise<string> {
  if (!hasTauriRuntime()) {
    return fallbackDefaultArtifactRootPath();
  }

  try {
    const flockRoot = (await getFlockRoot())?.root?.trim();
    const { path } = await resolvePath({
      parts: flockRoot
        ? [flockRoot, DEFAULT_ARTIFACT_ROOT_FOLDER_NAME]
        : [
            "~",
            FALLBACK_FLOCK_ROOT_FOLDER_NAME,
            DEFAULT_ARTIFACT_ROOT_FOLDER_NAME,
          ],
    });
    if (flockRoot) {
      lastResolvedDefaultArtifactRoot = path;
    }
    return path;
  } catch {
    return fallbackDefaultArtifactRootPath();
  }
}

export function getArtifactRootPreference(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return trimValue(
      getPreferenceStorage()?.getItem(ARTIFACT_ROOT_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

export function setArtifactRootPreference(path: string | null): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const trimmed = trimValue(path);
    if (trimmed) {
      getPreferenceStorage()?.setItem(ARTIFACT_ROOT_STORAGE_KEY, trimmed);
    } else {
      getPreferenceStorage()?.removeItem(ARTIFACT_ROOT_STORAGE_KEY);
    }
    window.dispatchEvent(new Event(ARTIFACT_ROOT_CHANGED_EVENT));
  } catch {
    // localStorage can be unavailable in restricted contexts.
  }
}

export async function resolveArtifactRootPath(
  override?: string | null,
): Promise<string> {
  const configured = trimValue(override) ?? getArtifactRootPreference();
  if (configured) {
    if (!hasTauriRuntime()) {
      return configured;
    }

    try {
      return (await resolvePath({ parts: [configured] })).path;
    } catch {
      return configured;
    }
  }

  return defaultArtifactRootPath();
}

export function getOptimisticArtifactCwd({
  artifactRootOverride,
}: SessionArtifactLocationOptions = {}): string {
  return (
    trimValue(artifactRootOverride) ??
    getArtifactRootPreference() ??
    lastResolvedDefaultArtifactRoot ??
    fallbackDefaultArtifactRootPath()
  );
}

export async function resolveSessionArtifactCwd(
  options: SessionArtifactLocationOptions = {},
): Promise<string> {
  const path = await resolveArtifactRootPath(options.artifactRootOverride);

  if (hasTauriRuntime()) {
    await ensureDirectory(path);
  }

  return path;
}
