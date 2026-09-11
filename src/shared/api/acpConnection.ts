import { invoke } from "@tauri-apps/api/core";
import {
  PROTOCOL_VERSION,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import packageJson from "../../../package.json";
import { createWebSocketStream } from "./createWebSocketStream";
import { HostClient } from "./hostClient";
import { perfLog } from "@/shared/lib/perfLog";

let notificationHandler: AcpNotificationHandler | null = null;
const sessionNotificationInterceptors =
  new Set<SessionNotificationInterceptor>();

export interface AcpNotificationHandler {
  handleSessionNotification(notification: SessionNotification): Promise<void>;
}

export type SessionNotificationInterceptor = (
  notification: SessionNotification,
) => boolean;

export function setNotificationHandler(handler: AcpNotificationHandler): void {
  notificationHandler = handler;
}

/**
 * Registers a short-lived interceptor for private/background ACP sessions.
 * Returning true consumes the notification so it is not added to the visible
 * chat store.
 */
export function interceptSessionNotifications(
  interceptor: SessionNotificationInterceptor,
): () => void {
  sessionNotificationInterceptors.add(interceptor);
  return () => sessionNotificationInterceptors.delete(interceptor);
}

/**
 * Handles ACP permission requests. When set, `requestPermission` delegates to
 * it; otherwise the connection falls back to auto-approving (preserving the
 * default behavior for environments where no handler is registered).
 */
export type PermissionRequestHandler = (
  request: RequestPermissionRequest,
) => Promise<RequestPermissionResponse>;

let permissionHandler: PermissionRequestHandler | null = null;

export function setPermissionHandler(handler: PermissionRequestHandler): void {
  permissionHandler = handler;
}

let clientPromise: Promise<HostClient> | null = null;
let resolvedClient: HostClient | null = null;
let activeStream: ReturnType<typeof createWebSocketStream> | null = null;

function createClientCallbacks(): () => Client {
  return () => ({
    requestPermission: async (
      args: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> => {
      if (permissionHandler) {
        return permissionHandler(args);
      }
      const optionId = args.options?.[0]?.optionId ?? "approve";
      return {
        outcome: {
          outcome: "selected",
          optionId,
        },
      };
    },

    sessionUpdate: async (notification: SessionNotification): Promise<void> => {
      for (const interceptor of sessionNotificationInterceptors) {
        if (interceptor(notification)) {
          return;
        }
      }
      if (notificationHandler) {
        await notificationHandler.handleSessionNotification(notification);
      }
    },
  });
}

function monitorConnection(
  client: HostClient,
  stream: ReturnType<typeof createWebSocketStream>,
): void {
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
 */
export async function invalidateClientConnection(): Promise<void> {
  const stream = activeStream;
  activeStream = null;
  resolvedClient = null;
  clientPromise = null;
  if (stream) {
    await stream.writable.abort();
  }
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
  await client.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: {
      name: packageJson.name,
      version: packageJson.version,
    },
  });
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
    clientPromise = initializeConnection()
      .then((client) => {
        resolvedClient = client;
        return client;
      })
      .catch((error) => {
        clientPromise = null;
        throw error;
      });
  } else {
    perfLog("[perf:conn] getClient() awaiting in-flight initializeConnection");
  }

  return clientPromise;
}

export function isClientReady(): boolean {
  return resolvedClient !== null;
}

export function getClientSync(): HostClient | null {
  return resolvedClient;
}
