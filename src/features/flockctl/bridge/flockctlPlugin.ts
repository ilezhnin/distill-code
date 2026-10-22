import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Rust broker → renderer command event (emitted to the main window only). */
const FLOCKCTL_REQUEST_EVENT = "flockctl:request";

/** Payload of an {@link FLOCKCTL_REQUEST_EVENT} event. */
export interface BridgeRequest {
  /** Correlates the response submitted via submit_result. */
  id: string;
  /** Command group name, e.g. "sessions". */
  command: string;
  /** Raw JSON args; validated in the renderer by zod. */
  args: unknown;
  /** The broker-resolved effective timeout for this call (ms). The renderer
   *  derives its deadline from this so a request `timeout_ms` override cannot
   *  skew the two sides' deadlines apart. */
  timeoutMs: number;
  /** Calling agent session's identity (AGENT_SESSION_ID), forwarded verbatim
   *  from the wire envelope. Absent for operator calls and app-internal
   *  dispatches. */
  actor?: string;
}

/** Renderer → Rust response, submitted via plugin:flockctl|submit_result. */
export interface BridgeResult {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

interface FlockctlEndpoint {
  port: number;
}

/** Starts the broker server (idempotent) and returns its loopback port. */
export async function startFlockctlServer(): Promise<FlockctlEndpoint> {
  return invoke<FlockctlEndpoint>("plugin:flockctl|start");
}

/** Stops the broker server. */
export async function stopFlockctlServer(): Promise<void> {
  await invoke("plugin:flockctl|stop");
}

interface BrokerStatus {
  running: boolean;
}

/**
 * Read-only broker liveness from the plugin — the single source of truth
 * for "an agent can reach the app through `flockctl` right now". Works from
 * any window: the broker lifecycle runs in the main window, but popped-out
 * session windows also send prompts and must not keep a renderer-local copy
 * of an app-global fact.
 */
export async function getFlockctlBrokerStatus(): Promise<BrokerStatus> {
  return invoke<BrokerStatus>("plugin:flockctl|status");
}

/** Pushes the per-command timeout map (ms); the broker clamps each value to
 *  its MAX_COMMAND_TIMEOUT and uses its default for commands not listed. */
export async function setFlockctlTimeouts(
  timeouts: Record<string, number>,
): Promise<void> {
  await invoke("plugin:flockctl|set_timeouts", { timeouts });
}

/** Submits a command result back to the broker (duplicate-tolerant). */
export async function submitFlockctlResult(
  result: BridgeResult,
): Promise<void> {
  await invoke("plugin:flockctl|submit_result", { result });
}

/**
 * Listens for broker command requests; a no-op unlistener outside the Tauri
 * webview.
 */
export function listenFlockctlRequests(
  handler: (request: BridgeRequest) => void,
): Promise<UnlistenFn> {
  if (!window.__TAURI_INTERNALS__) {
    return Promise.resolve(() => {});
  }

  return listen<BridgeRequest>(FLOCKCTL_REQUEST_EVENT, (event) =>
    handler(event.payload),
  );
}

/**
 * True when an invoke rejection means the flockctl plugin is not in this
 * build (Cargo feature off) or not granted to this window. Covers both Tauri
 * shapes: ACL denial ("flockctl.start not allowed. Permissions associated
 * with this command: …") and unknown command ("Command flockctl|start not
 * found").
 */
export function isPluginUnavailableError(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error ?? "");
  const normalized = message.toLowerCase();
  if (!normalized.includes("flockctl")) {
    return false;
  }
  return normalized.includes("not allowed") || normalized.includes("not found");
}
