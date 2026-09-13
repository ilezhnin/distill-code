import { useEffect } from "react";

import { eventMatchesShortcutCommand } from "@/features/shortcuts/lib/shortcutRegistry";

const KEY = "goose-zoom-level";
const STEP = 0.1;
const MIN = 0.7;
const MAX = 1.3;

function adjust(n: number) {
  return Math.round(Math.min(MAX, Math.max(MIN, n)) * 100) / 100;
}

/**
 * WebView2 throws `SecurityError` when DOM storage is blocked (policy, a
 * corrupt storage database, a read-only user-data folder). An unguarded read
 * threw inside the effect and put the whole app on the error screen.
 */
function getStored(): number {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    return 1.0;
  }
  const v = Number.parseFloat(stored ?? "");
  return Number.isNaN(v) ? 1.0 : adjust(v);
}

function storeZoom(level: number): void {
  try {
    localStorage.setItem(KEY, String(level));
  } catch {
    // Storage is unavailable; the zoom still applies for this run.
  }
}

function applyZoom(level: number) {
  document.documentElement.style.setProperty(
    "--goose-content-zoom",
    String(level),
  );
}

export function useZoom() {
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;

    let level = getStored();
    applyZoom(level);

    const handler = (e: KeyboardEvent) => {
      if (eventMatchesShortcutCommand(e, "view.zoomIn")) {
        level = adjust(level + STEP);
      } else if (eventMatchesShortcutCommand(e, "view.zoomOut")) {
        level = adjust(level - STEP);
      } else if (eventMatchesShortcutCommand(e, "view.zoomReset")) {
        level = adjust(1.0);
      } else {
        return;
      }

      e.preventDefault();
      storeZoom(level);
      applyZoom(level);
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
