import { showMainWindow } from "@/app/lib/showMainWindow";
import { getInitialLocale } from "@/shared/i18n/locale";
import en from "@/shared/i18n/locales/en/common.json";
import es from "@/shared/i18n/locales/es/common.json";

const MODULE_RETRY = "flock:startup-module-retry";

export function clearStartupRetry(): void {
  try {
    sessionStorage.removeItem(MODULE_RETRY);
  } catch {
    // Storage can be unavailable while the WebView is starting.
  }
}

/** The renderer graph may not load at all, so this recovery screen cannot
 * depend on React, its providers or their stylesheets. */
export function showStartupFailure(error: unknown): void {
  // Vite can replace its dependency graph during the first load. A failed
  // module stays cached in this document, so retry through one navigation,
  // never an import loop. Persistent failures must remain visible.
  if (
    error instanceof TypeError &&
    error.message.startsWith("Failed to fetch dynamically imported module")
  ) {
    try {
      if (sessionStorage.getItem(MODULE_RETRY) !== "1") {
        sessionStorage.setItem(MODULE_RETRY, "1");
        window.location.reload();
        return;
      }
    } catch {
      // Show recovery even when the retry marker cannot be saved.
    }
  }
  const messages = getInitialLocale() === "es" ? es : en;
  const panel = document.createElement("main");
  panel.setAttribute("role", "alert");
  panel.style.cssText =
    "box-sizing:border-box;max-width:48rem;margin:10vh auto;padding:2rem;font:16px/1.5 system-ui;overflow-wrap:anywhere;color:CanvasText;background:Canvas;color-scheme:light dark";
  const heading = document.createElement("h1");
  heading.textContent = messages.startup.error.unknown.title;
  const description = document.createElement("p");
  description.textContent = messages.rendererError.description;
  const details = document.createElement("pre");
  details.style.whiteSpace = "pre-wrap";
  details.textContent = String(error);
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = messages.rendererError.reload;
  reload.style.cssText = "font:inherit;padding:.5rem 1rem;cursor:pointer";
  // A fresh document also discards failed ES module imports cached by the
  // WebView. Retrying import() in this document would reuse that failure.
  reload.addEventListener("click", () => {
    clearStartupRetry();
    window.location.reload();
  });
  panel.append(heading, description, details, reload);
  document.getElementById("root")?.replaceChildren(panel);
  showMainWindow();
}
