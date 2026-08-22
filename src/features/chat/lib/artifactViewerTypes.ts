/**
 * Classifies a file path into a viewer "view mode". This is the extension
 * point for the in-app artifact viewer: new renderable types are added here
 * without touching the panel or the trigger.
 *
 * Supported:
 *  - "markdown": rendered (Streamdown) with a Preview <-> Raw toggle
 *  - "image": rendered via convertFileSrc
 *  - "code": syntax-highlighted text (source, config, and other UTF-8 files)
 *
 * Known binary types return null so callers keep "open externally". The
 * backend still rejects binary/non-UTF-8 reads for anything we do open.
 */
import type { ToolRequestContent } from "@/shared/types/messages";
export type ArtifactViewMode = "markdown" | "image" | "code";

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
]);

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".aac",
  ".apk",
  ".avi",
  ".bin",
  ".blend",
  ".bz2",
  ".class",
  ".db",
  ".dll",
  ".dmg",
  ".doc",
  ".docx",
  ".dylib",
  ".eot",
  ".exe",
  ".fbx",
  ".flac",
  ".gz",
  ".icns",
  ".ico",
  ".iso",
  ".jar",
  ".lib",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".obj",
  ".ogg",
  ".otf",
  ".pdf",
  ".ppt",
  ".pptx",
  ".psd",
  ".pyc",
  ".pyo",
  ".rar",
  ".so",
  ".sqlite",
  ".tar",
  ".tgz",
  ".ttf",
  ".wasm",
  ".wav",
  ".webm",
  ".woff",
  ".woff2",
  ".xls",
  ".xlsx",
  ".xz",
  ".zip",
]);

/** Basename of a path, tolerant of both `/` and `\` separators. */
export function artifactBasename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").pop() || path;
}

export function fileExtension(path: string): string {
  const name = artifactBasename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot).toLowerCase();
}

export function classifyArtifactView(path: string): ArtifactViewMode | null {
  const ext = fileExtension(path);
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (BINARY_EXTENSIONS.has(ext)) return null;
  return "code";
}

/**
 * True when this path can be previewed inside the app. When false, callers
 * keep the existing "open externally" behavior — the viewer never mounts.
 */
export interface ViewableArtifactTarget {
  path: string;
  filename: string;
}

/**
 * Every distinct viewable artifact (markdown/image/code) across the given tool
 * requests, in first-seen order.
 *
 * This replaced an earlier `singleViewableArtifact` helper that collapsed to
 * null whenever a chain touched two or more files. That kept a *header* action
 * unambiguous, but it also meant the busiest chains — the ones where getting
 * back to a file matters most — offered no way back, and the same document
 * surfaced as a different-looking control depending on how the run grouped.
 * Inline chips render one affordance per file, so they need the full list.
 */
export function viewableArtifacts(
  requests: Iterable<ToolRequestContent | undefined>,
): ViewableArtifactTarget[] {
  const seen = new Set<string>();
  const viewable: ViewableArtifactTarget[] = [];
  for (const request of requests) {
    for (const location of request?.locations ?? []) {
      const path = location.path;
      if (!path || seen.has(path)) continue;
      seen.add(path);
      if (!isViewableArtifact(path)) continue;
      viewable.push({ path, filename: artifactBasename(path) });
    }
  }
  return viewable;
}

export function isViewableArtifact(path: string): boolean {
  return classifyArtifactView(path) !== null;
}
