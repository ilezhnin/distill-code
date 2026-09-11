/**
 * Shows the app window. It is created hidden (`visible: false` in
 * tauri.conf.json) so the first paint is not a blank frame, and nothing on the
 * Rust side shows it at startup: the renderer must, including when it only has
 * an error screen to show.
 */
export function showMainWindow(): void {
  // Dynamic import so non-Tauri environments (e.g. Playwright E2E) never load
  // the window API.
  if (!window.__TAURI_INTERNALS__) return;
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().show())
    .catch((error: unknown) => {
      console.error("Failed to show the app window:", error);
    });
}
