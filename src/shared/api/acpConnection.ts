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
 * Abort the current transport after an ACP request exceeds its liveness bound.
 * A timed-out request leaves the connection state unknowable; reconnecting is
 * safer than allowing later mutations to race work still running remotely.
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
