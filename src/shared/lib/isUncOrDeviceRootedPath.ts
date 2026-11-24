import { fileUrlToPath, isFileUrl } from "@/shared/lib/pathIdentity";

/**
 * True when a path that came from outside (tool output, a model's text) is
 * rooted at a server or a device instead of a local drive or folder:
 * `\\server\share\x` with its separators in any mix or percent-encoded
 * (`//server`, `/\server`, `%5C%5Cserver`), the device namespaces `\\?\`,
 * `\\.\` and `\??\`, which reach a server through `UNC`, and a `file:` URL
 * that names a server.
 *
 * On Windows every filesystem call on such a path connects to the server it
 * names and offers the user's credentials. The test therefore comes before
 * any call and is purely lexical: nothing is probed to make it. Win32 decides
 * what kind of path it has from the first characters alone, and so does this.
 *
 * Only the *incoming* spelling is judged. A relative path is let through even
 * when the folder it will be resolved against is on a share: that folder is
 * the user's own choice.
 *
 * A `file:` URL is judged by the path `fileUrlToPath` makes of it, so the
 * answer is about the string a caller would hand on. A URL that converter
 * refuses names no local path either and is refused here as well.
 */
export function isUncOrDeviceRootedPath(path: string): boolean {
  const incoming = path.trim();
  if (isFileUrl(incoming)) {
    const converted = fileUrlToPath(incoming);
    return converted === null || hasUncOrDeviceRoot(converted);
  }
  return hasUncOrDeviceRoot(incoming);
}

function hasUncOrDeviceRoot(path: string): boolean {
  // Each escape is read on its own instead of through `decodeURIComponent`:
  // one malformed escape further on makes that throw, and the root would go
  // unread.
  const spelled = path.replace(/\\|%5c|%2f/gi, "/").replace(/%3f/gi, "?");
  return spelled.startsWith("//") || spelled.startsWith("/??/");
}
