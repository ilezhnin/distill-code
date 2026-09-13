import { convertFileSrc } from "@tauri-apps/api/core";
import { fileUrlToPath, isFileUrl } from "@/shared/lib/pathIdentity";

interface ImageContentLike {
  data?: string | null;
  mimeType?: string | null;
  uri?: string | null;
}

/**
 * Every spelling of the Tauri asset scheme the webview accepts: the Windows /
 * Android form `http(s)://asset.localhost/<encoded path>` and the custom-scheme
 * form `asset://localhost/<encoded path>`.
 */
const ASSET_URL_RE = /^(?:https?:\/\/asset\.localhost|asset:\/\/localhost)\//i;

/**
 * The filesystem path an `asset:` URL points at, or `null` when `src` is not
 * one. Such a URL reads as "remote" to a naive scheme check while actually
 * naming a local file, so callers that scope local images to the chat's
 * folders have to unwrap it before deciding.
 */
export function assetUrlToPath(src: string): string | null {
  const trimmed = src.trim();
  if (!ASSET_URL_RE.test(trimmed)) return null;
  const encodedPath = trimmed
    .replace(ASSET_URL_RE, "")
    .split("#")[0]
    .split("?")[0];
  if (!encodedPath) return null;
  try {
    const decoded = decodeURIComponent(encodedPath);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the best renderable `src` for an ACP image content block.
 *
 * ACP image blocks always carry base64 `data` and may *also* carry a `uri`
 * (e.g. an image-generating MCP can return `file:///tmp/generated.png` plus the
 * base64 bytes). The previous `uri ?? data:` ordering preferred the `file://`
 * URI, which the webview/CSP cannot load — so a perfectly valid inline image
 * rendered broken. Resolution order:
 *
 *   1. Inline base64 `data` when present — always loadable in the webview.
 *   2. A local `file://` URI converted through the Tauri `asset:` scheme so the
 *      webview can actually fetch it (a raw `file://` is blocked).
 *   3. Any other URI (http(s)/data) verbatim.
 *
 * Returns `null` when there is nothing renderable.
 *
 * `isPathAllowed`, when given, decides whether a *local* URI may be rendered:
 * an image block's `uri` is agent-supplied, and the asset scope the webview
 * enforces covers the whole of `$HOME`, so without it a tool could display any
 * picture in the user's home directory by naming it. Inline `data` and remote
 * URIs are unaffected — there is no local file to scope.
 */
export function resolveImageContentSrc(
  content: ImageContentLike,
  isPathAllowed?: (path: string) => boolean,
): string | null {
  const data = typeof content.data === "string" ? content.data : "";
  const mimeType =
    typeof content.mimeType === "string" && content.mimeType.length > 0
      ? content.mimeType
      : "image/png";

  // Prefer inline bytes whenever present — they always render in the webview.
  if (data.length > 0) {
    return `data:${mimeType};base64,${data}`;
  }

  const uri = typeof content.uri === "string" ? content.uri.trim() : "";
  if (uri.length === 0) {
    return null;
  }

  // A raw file:// URI is not loadable under the webview/CSP; route local files
  // through the asset scheme. convertFileSrc expects a decoded filesystem path.
  // A file:// URI that fails to convert is malformed/unsafe — return null
  // rather than handing the raw file:// string to the webview.
  if (isFileUrl(uri)) {
    const filePath = fileUrlToPath(uri);
    if (!filePath || filePath.length === 0) return null;
    if (isPathAllowed && !isPathAllowed(filePath)) return null;
    return convertFileSrc(filePath, "asset");
  }

  // An `asset:` URL is a local file wearing a remote-looking scheme; it gets
  // the same scoping as a `file://` one rather than passing as "any other URI".
  const assetPath = assetUrlToPath(uri);
  if (assetPath) {
    return isPathAllowed && !isPathAllowed(assetPath) ? null : uri;
  }

  return uri;
}
