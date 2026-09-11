import { invoke } from "@tauri-apps/api/core";

export type RendererLogLevel = "info" | "warn" | "error";

/** Forward a renderer lifecycle event to the backend app log (`berd.log`). */
export async function logRendererEvent(
  level: RendererLogLevel,
  message: string,
): Promise<void> {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) {
    return;
  }
  try {
    await invoke("log_renderer_event", { level, message });
  } catch {
    // Logging is best-effort; never let it break the UI.
  }
}
