export function defaultExportFilename(title: string): string {
  const sanitized = title
    .trim()
    .replaceAll(/[<>:"/\\|?*]/g, "-")
    .replaceAll(/[\r\n\t]/g, "-")
    .split("")
    .map((char) => (char < " " ? "-" : char))
    .join("")
    .replace(/\s+/g, " ")
    .slice(0, 120);

  return `${sanitized || "session"}.json`;
}

export function exportFilenameFromPath(
  path: string,
  fallbackFilename: string,
): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const filename = normalized.split("/").pop();
  return filename?.trim() ? filename : fallbackFilename;
}

export interface SettledExports<T> {
  items: T[];
  failures: unknown[];
}

/**
 * Loads every export of a bulk selection and keeps the ones that came back: a
 * single unreadable chat must not throw away the rest of the batch. Callers
 * report `failures.length` next to the saved count.
 */
export async function collectSettledExports<T>(
  ids: readonly string[],
  load: (id: string) => Promise<T>,
): Promise<SettledExports<T>> {
  const results = await Promise.allSettled(ids.map((id) => load(id)));
  const items: T[] = [];
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      items.push(result.value);
      continue;
    }
    failures.push(result.reason);
  }
  return { items, failures };
}

export function downloadJson(json: string, filename: string): void {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
