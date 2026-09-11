/** True when the path points into the user's home directory via a `~` prefix. */
export function isHomeRelativePath(path: string): boolean {
  return path === "~" || path.startsWith("~/") || path.startsWith("~\\");
}

/**
 * Expand a leading `~` to the user's home directory so both spellings of the
 * same directory (`~/foo` and `C:\Users\me\foo`) collapse to one canonical
 * path — and therefore one backend request/cache entry wherever paths are used
 * as keys. The remainder takes the home directory's separator, so on Windows
 * the expansion matches the backslash spelling the backend reports.
 * Non-home-relative paths pass through untouched.
 */
export function expandHomePath(path: string, homeDir: string): string {
  if (!isHomeRelativePath(path)) {
    return path;
  }
  const normalizedHome = homeDir.replace(/[\\/]+$/, "");
  if (path === "~") {
    return normalizedHome || "/";
  }
  const separator =
    homeDir.includes("\\") && !homeDir.includes("/") ? "\\" : "/";
  const remainder = path.slice(2).replace(/[\\/]/g, separator);
  return `${normalizedHome}${separator}${remainder}`;
}
