import { invoke } from "@tauri-apps/api/core";
import {
  PROTOCOL_VERSION,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import packageJson from "../../../package.json";
import {
  createWebSocketStream,
  type WebSocketStream,
} from "./createWebSocketStream";
import { HostClient } from "./hostClient";
import { perfLog } from "@/shared/lib/perfLog";

let notificationHandler: AcpNotificationHandler | null = null;

export interface AcpNotificationHandler {
  handleSessionNotification(notification: SessionNotification): Promise<void>;
}

export function setNotificationHandler(handler: AcpNotificationHandler): void {
  notificationHandler = handler;
}

/**
 * Nothing in the app asks the operator about individual tool calls: a
 * harness that still sends a permission request gets a one-time allow. An
 * "always" answer would change the harness's own saved permissions, so it is
 * only chosen when the request offers no one-time allow.
 */
function allowOnce(args: RequestPermissionRequest): RequestPermissionResponse {
  const options = args.options ?? [];
  const option =
    options.find((candidate) => candidate.kind === "allow_once") ??
    options.find((candidate) => candidate.kind === "allow_always") ??
    options[0];
  if (!option) {
    return { outcome: { outcome: "cancelled" } };
  }
  return { outcome: { outcome: "selected", optionId: option.optionId } };
}

let clientPromise: Promise<HostClient> | null = null;
let resolvedClient: HostClient | null = null;
let activeStream: WebSocketStream | null = null;

function createClientCallbacks(): () => Client {
  return () => ({
    requestPermission: async (
      args: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> => allowOnce(args),

    sessionUpdate: async (notification: SessionNotification): Promise<void> => {
      if (notificationHandler) {
        await notificationHandler.handleSessionNotification(notification);
      }
    },
  });
}

function monitorConnection(client: HostClient, stream: WebSocketStream): void {
  const clearCurrentConnection = () => {
    if (activeStream !== stream) {
      return;
    }
    resolvedClient = null;
    clientPromise = null;
    activeStream = null;
  };
  client.closed
    .then(() => {
      console.warn(
        "[acp] Connection closed. Will reconnect on next getClient().",
      );
      clearCurrentConnection();
    })
    .catch(() => {
      console.warn(
        "[acp] Connection error. Will reconnect on next getClient().",
      );
      clearCurrentConnection();
    });
}

/**
 * Drop the current transport. Every request still pending on it is rejected
 * with "ACP connection closed", so this is reserved for a socket that is
 * known to be dead or was never established; a request that merely timed out
 * goes through `invalidateClientConnectionIfUnresponsive` instead.
 *
 * The socket is closed directly: aborting the writable side is refused while
 * a writer holds it, which would leave the old socket open and every request
 * still waiting on it unanswered.
 */
export async function invalidateClientConnection(): Promise<void> {
  const stream = activeStream;
  activeStream = null;
  resolvedClient = null;
  clientPromise = null;
  stream?.close();
}

const CONNECTION_PROBE_TIMEOUT_MS = 10_000;

let pendingPromptCount = 0;

/**
 * Count a `session/prompt` for as long as it is in flight. The one socket is
 * shared by every chat, so closing it fails every streaming turn at once;
 * the count is what keeps a timed-out config call in one chat from doing
 * that to the others.
 */
export function trackPendingPrompt<T>(prompt: Promise<T>): Promise<T> {
  pendingPromptCount += 1;
  return prompt.finally(() => {
    pendingPromptCount -= 1;
  });
}

export function hasPendingPrompts(): boolean {
  return pendingPromptCount > 0;
}

async function probeConnection(client: HostClient): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    // `initialize` is answered by the host itself, from its own task, so it
    // is not held up by whatever bridge call the timed-out request is stuck
    // behind: a missing answer means the transport, not one bridge, is gone.
    await Promise.race([
      client.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: {
          name: packageJson.name,
          version: packageJson.version,
        },
      }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("ACP connection probe timed out"));
        }, CONNECTION_PROBE_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch (error) {
    console.warn("[acp] Connection probe failed:", error);
    return false;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * After a bounded request timed out: decide whether the transport itself is
 * dead. The timeout says nothing about the socket — the host answers every
 * request from its own task, so one hung bridge call (a bridge install, an
 * `initialize` that never answers) leaves the socket healthy and every other
 * chat's prompt streaming over it. The socket is dropped only when a probe
 * gets no answer and no prompt is pending on it; a connection that never
 * came up within the bound is dropped so the next `getClient()` can retry.
 * Returns whether the connection was invalidated.
 */
export async function invalidateClientConnectionIfUnresponsive(): Promise<boolean> {
  const client = resolvedClient;
  if (!client) {
    if (clientPromise) {
      await invalidateClientConnection();
      return true;
    }
    return false;
  }
  if (await probeConnection(client)) {
    return false;
  }
  if (resolvedClient !== client) {
    return false;
  }
  if (hasPendingPrompts()) {
    console.warn(
      "[acp] Connection probe failed while prompts are pending; keeping the socket open.",
    );
    return false;
  }
  await invalidateClientConnection();
  return true;
}

async function initializeConnection(): Promise<HostClient> {
  const tStart = performance.now();
  const wsUrl: string = await invoke("get_agent_host_url");
  perfLog(
    `[perf:conn] get_agent_host_url in ${(performance.now() - tStart).toFixed(1)}ms`,
  );

  const stream = createWebSocketStream(wsUrl);
  activeStream = stream;
  const client = new HostClient(createClientCallbacks(), stream);

  const tInit = performance.now();
  try {
    await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: {
        name: packageJson.name,
        version: packageJson.version,
      },
    });
  } catch (error) {
    // A socket that never finished the handshake must not linger: the host
    // treats the newest socket as the renderer's, and this one would stay
    // open, unanswered, next to the retry's.
    if (activeStream === stream) {
      activeStream = null;
    }
    stream.close();
    throw error;
  }
  perfLog(
    `[perf:conn] client.initialize in ${(performance.now() - tInit).toFixed(1)}ms (total ${(performance.now() - tStart).toFixed(1)}ms)`,
  );

  monitorConnection(client, stream);

  return client;
}

export async function getClient(): Promise<HostClient> {
  if (resolvedClient) {
    return resolvedClient;
  }

  if (!clientPromise) {
    perfLog("[perf:conn] getClient() → initializing new ACP connection");
    // A connection invalidated while it was still initializing must not be
    // cached when it resolves: its socket is already closed, and the close
    // monitor no longer recognises it, so it would be handed out forever.
    const pending: Promise<HostClient> = initializeConnection()
      .then((client) => {
        if (clientPromise === pending) {
          resolvedClient = client;
        }
        return client;
      })
      .catch((error) => {
        if (clientPromise === pending) {
          clientPromise = null;
        }
        throw error;
      });
    clientPromise = pending;
  } else {
    perfLog("[perf:conn] getClient() awaiting in-flight initializeConnection");
  }

  return clientPromise;
}
