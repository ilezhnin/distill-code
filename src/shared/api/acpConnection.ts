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
import { logRendererEvent } from "./rendererLog";

let notificationHandler: AcpNotificationHandler | null = null;

/**
 * A permission request the renderer answered on its own, reported so the chat
 * can say so where the operator will see it.
 */
export interface AcpPermissionAnswerReport {
  sessionId?: string;
  /** The harness's own name for the tool call, already clamped for display. */
  toolLabel?: string;
  /** `cancelled` means nothing refusable was offered — see below. */
  answer: "allow_once" | "reject_once" | "cancelled";
}

export interface AcpNotificationHandler {
  handleSessionNotification(notification: SessionNotification): Promise<void>;
  /**
   * Optional. Called for an answer the operator would want to know about — a
   * request the app could only cancel. Nothing about the transport depends on
   * it, so a handler that does not implement it simply gets the log line.
   */
  reportPermissionAnswer?(report: AcpPermissionAnswerReport): void;
}

export function setNotificationHandler(handler: AcpNotificationHandler): void {
  notificationHandler = handler;
}

/** Agent-controlled text, made safe for one log line and one transcript row. */
function permissionToolLabel(args: RequestPermissionRequest): string {
  const raw = args.toolCall?.title ?? args.toolCall?.toolCallId ?? "?";
  // The title comes from the bridge and is neither bounded nor single-line,
  // and `log_renderer_event` writes what it is given: clamp it here so a
  // harness cannot author arbitrary multi-line content in berd.log.
  const oneLine = raw.replace(/[\r\n\t]+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine;
}

/**
 * Nothing in the app asks the operator about individual tool calls: a harness
 * that still sends a permission request gets a one-time allow. An "always"
 * answer is never chosen — it rewrites the harness's own saved permissions for
 * every future session, which nobody asked for and nothing in the app can undo
 * — so a request that offers no one-time allow is refused once instead, and
 * cancelled when it offers nothing to refuse with either. Every answer goes to
 * the app log, and the one the operator would otherwise never notice — the
 * cancel — is also reported to the chat (see `reportPermissionAnswer`): per
 * ACP, `cancelled` ends the *turn* rather than refusing one tool call, so a
 * harness offering only permanent options stops mid-task with no other trace.
 */
export function answerPermissionRequest(
  args: RequestPermissionRequest,
): RequestPermissionResponse {
  const options = args.options ?? [];
  const option =
    options.find((candidate) => candidate.kind === "allow_once") ??
    options.find((candidate) => candidate.kind === "reject_once");
  const offered = options
    .map((candidate) => candidate.kind ?? "unknown")
    .join(",");
  const toolLabel = permissionToolLabel(args);
  void logRendererEvent(
    "warn",
    `[acp] permission request answered without asking: session=${args.sessionId?.slice(0, 8) ?? "?"} tool=${toolLabel} offered=[${offered}] answer=${option?.kind ?? "cancelled"}`,
  );
  if (!option) {
    notificationHandler?.reportPermissionAnswer?.({
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      toolLabel,
      answer: "cancelled",
    });
    return { outcome: { outcome: "cancelled" } };
  }
  return { outcome: { outcome: "selected", optionId: option.optionId } };
}

let clientPromise: Promise<HostClient> | null = null;
let resolvedClient: HostClient | null = null;
let activeStream: WebSocketStream | null = null;
// Bumped by every invalidation so a connection attempt that was still
// waiting on the host URL when the invalidation happened knows it lost.
let connectionGeneration = 0;

function createClientCallbacks(): () => Client {
  return () => ({
    requestPermission: async (
      args: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> => answerPermissionRequest(args),

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
  connectionGeneration += 1;
  activeStream = null;
  resolvedClient = null;
  clientPromise = null;
  consecutiveProbeFailures = 0;
  stream?.close();
}

const CONNECTION_PROBE_TIMEOUT_MS = 10_000;

/**
 * How many probes in a row may go unanswered before a pending prompt stops
 * protecting the socket. A prompt on a black-holed socket never settles —
 * nothing aborts `client.prompt` — so the pending count alone would keep a
 * dead transport forever; two unanswered probes (10 s each, each raised by a
 * separate timed-out mutation) is the point where "one bridge call is stuck"
 * stops being the better explanation.
 */
const MAX_CONSECUTIVE_PROBE_FAILURES = 2;

let consecutiveProbeFailures = 0;

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
 * chat's prompt streaming over it. A probe that gets no answer while a prompt
 * is pending therefore keeps the socket — but only up to a bound: the socket
 * is dropped anyway once the transport itself reports the socket closed or
 * closing, or once the probe has gone unanswered
 * `MAX_CONSECUTIVE_PROBE_FAILURES` times in a row, because a prompt pending on
 * a dead socket never settles and would otherwise protect it forever. A
 * connection that never came up within the bound is dropped so the next
 * `getClient()` can retry. Returns whether the connection was invalidated.
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
    consecutiveProbeFailures = 0;
    return false;
  }
  if (resolvedClient !== client) {
    return false;
  }
  consecutiveProbeFailures += 1;
  // A socket the transport has already given up on cannot answer anything,
  // pending prompt or not: keeping it only hides the reconnect.
  const socketIsGone = activeStream?.isSocketClosed() ?? true;
  if (
    hasPendingPrompts() &&
    !socketIsGone &&
    consecutiveProbeFailures < MAX_CONSECUTIVE_PROBE_FAILURES
  ) {
    console.warn(
      "[acp] Connection probe failed while prompts are pending; keeping the socket open.",
    );
    return false;
  }
  await invalidateClientConnection();
  return true;
}

export class AcpConnectionSupersededError extends Error {
  constructor() {
    super("ACP connection attempt was superseded by a reconnect.");
    this.name = "AcpConnectionSupersededError";
  }
}

async function initializeConnection(): Promise<HostClient> {
  const generation = connectionGeneration;
  const isCurrentAttempt = () => connectionGeneration === generation;
  const tStart = performance.now();
  const wsUrl: string = await invoke("get_agent_host_url");
  perfLog(
    `[perf:conn] get_agent_host_url in ${(performance.now() - tStart).toFixed(1)}ms`,
  );
  // An invalidation that ran while the host URL was still being fetched has
  // nothing to close yet; opening this socket now would make it the host's
  // "newest" socket while nobody holds its client.
  if (!isCurrentAttempt()) {
    throw new AcpConnectionSupersededError();
  }

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
    if (!isCurrentAttempt()) {
      throw new AcpConnectionSupersededError();
    }
  } catch (error) {
    // A socket that never finished the handshake, or was superseded while
    // finishing it, must not linger: the host treats the newest socket as
    // the renderer's, and this one would stay open, unanswered, next to the
    // retry's.
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
        // The caller still wants a client; the reconnect that superseded
        // this attempt is the one to hand out.
        if (error instanceof AcpConnectionSupersededError) {
          return getClient();
        }
        throw error;
      });
    clientPromise = pending;
  } else {
    perfLog("[perf:conn] getClient() awaiting in-flight initializeConnection");
  }

  return clientPromise;
}
