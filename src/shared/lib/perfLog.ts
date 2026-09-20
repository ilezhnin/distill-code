/**
 * Gated performance logger for frontend timing instrumentation.
 *
 * Enabled when any of the following is true:
 *   - Running under Vite dev (`import.meta.env.DEV`)
 *   - `localStorage.getItem("distill.perf") === "1"`
 *
 * Otherwise a no-op, so perf call sites add zero runtime cost in release
 * builds for users who have not opted in.
 *
 * Messages are prefixed with `[perf:<channel>]` by callers; this helper
 * is intentionally dumb and forwards the already-formatted string.
 *
 * When enabled, each line also goes to the host log (`distill.log`) next to the
 * agent host's own lines, so a slow chat open can be read as one timeline
 * without devtools attached. Volume is a handful of lines per navigation.
 */
import { logRendererEvent } from "@/shared/api/rendererLog";

function isEnabled(): boolean {
  try {
    if (import.meta.env?.DEV) return true;
  } catch {
    // import.meta may be unavailable in some test contexts
  }
  try {
    if (
      typeof localStorage !== "undefined" &&
      localStorage.getItem("distill.perf") === "1"
    ) {
      return true;
    }
  } catch {
    // localStorage can throw in restricted contexts
  }
  return false;
}

const enabled = isEnabled();

export function perfLog(message: string): void {
  if (!enabled) return;
  // eslint-disable-next-line no-console
  console.log(message);
  void logRendererEvent("info", message);
}
