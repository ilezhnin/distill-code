import { useEffect } from "react";
import { logRendererEvent } from "@/shared/api/rendererLog";

const LAST_BOOT_KEY = "distill.renderer.lastBootAt";

/**
 * If two production boots happen within this window the renderer likely
 * reloaded on its own (for example, a WebKit OOM reap) rather than the user
 * restarting. Dev reloads are expected during Vite/Tauri workflows.
 */
const RAPID_RELOAD_MS = 60_000;

// Module-scoped so React StrictMode's double-mount in dev doesn't double-log.
let bootReported = false;

function reportBoot(): void {
  if (bootReported) {
    return;
  }
  bootReported = true;

  let previousBootAt: number | null = null;
  try {
    const raw = localStorage.getItem(LAST_BOOT_KEY);
    previousBootAt = raw ? Number.parseInt(raw, 10) : null;
    localStorage.setItem(LAST_BOOT_KEY, String(Date.now()));
  } catch {
    // localStorage may be unavailable; still report the boot below.
  }

  if (previousBootAt && Number.isFinite(previousBootAt)) {
    const elapsedMs = Date.now() - previousBootAt;
    const elapsedSec = Math.round(elapsedMs / 1000);
    if (elapsedMs >= 0 && elapsedMs < RAPID_RELOAD_MS) {
      const isDev = import.meta.env.DEV && import.meta.env.MODE !== "test";
      void logRendererEvent(
        isDev ? "info" : "warn",
        isDev
          ? `renderer reloaded ${elapsedSec}s after the previous load during dev`
          : `renderer reloaded ${elapsedSec}s after the previous load; likely an unexpected reload (possible OOM reap)`,
      );
    } else {
      void logRendererEvent(
        "info",
        `renderer booted (previous load ${elapsedSec}s ago)`,
      );
    }
  } else {
    void logRendererEvent("info", "renderer booted (first load this install)");
  }
}

/** Headless component that records each renderer (re)boot in `distill.log`. */
export function RendererBootLog() {
  useEffect(() => {
    reportBoot();
  }, []);

  return null;
}
