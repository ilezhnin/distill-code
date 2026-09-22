import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

function isAcpDebugEnabled(): boolean {
  if (!import.meta.env.DEV) return false;

  const g = globalThis as {
    ACP_DEBUG?: unknown;
    localStorage?: { getItem?: (k: string) => string | null };
  };

  try {
    return (
      g.ACP_DEBUG === true ||
      g.ACP_DEBUG === "1" ||
      !!g.localStorage?.getItem?.("ACP_DEBUG")
    );
  } catch {
    return false;
  }
}

const acpDebugEnabled = isAcpDebugEnabled();

function acpDebug(label: string, payload: unknown): void {
  if (!acpDebugEnabled) return;
  console.debug(`[acp] ${label}`, payload);
}

/**
 * Maps the SDK's per-connection request ids to and from a space that is
 * unique to one socket.
 *
 * The SDK numbers requests from 0 on every new connection, and the host
 * keeps running a request whose socket went away and answers it on whatever
 * socket is current. Without this, a late reply for old request 7 resolves
 * whichever new request happens to be 7. Outgoing request ids are prefixed
 * with the connection's epoch (`"<epoch>:<id>"`; the host echoes ids
 * verbatim) and replies are mapped back; a reply carrying another epoch is
 * dropped instead of delivered.
 */
export interface RequestIdSpace {
  /** Rewrite an outgoing message; only this side's requests are touched. */
  toWire(message: AnyMessage): AnyMessage;
  /**
   * Map an incoming message back; `null` for a reply that answers a request
   * of another connection. Host-originated requests and notifications pass
   * through untouched.
   */
  fromWire(message: AnyMessage): AnyMessage | null;
}

export function createRequestIdSpace(epoch: string): RequestIdSpace {
  const prefix = `${epoch}:`;
  return {
    toWire(message) {
      if (!("method" in message) || !("id" in message)) {
        return message;
      }
      if (typeof message.id !== "number") {
        return message;
      }
      return { ...message, id: `${prefix}${message.id}` };
    },
    fromWire(message) {
      if ("method" in message || !("id" in message)) {
        return message;
      }
      const { id } = message;
      if (typeof id !== "string" || !id.startsWith(prefix)) {
        return null;
      }
      const local = Number(id.slice(prefix.length));
      if (!Number.isInteger(local)) {
        return null;
      }
      return { ...message, id: local };
    },
  };
}

// A reload of the renderer restarts the connection counter while the host
// keeps running requests of the previous renderer instance, so the epoch
// carries a per-instance token as well as the counter.
const instanceToken = Math.random().toString(36).slice(2, 10);
let connectionCounter = 0;

function nextConnectionEpoch(): string {
  connectionCounter += 1;
  return `${instanceToken}.${connectionCounter}`;
}

/**
 * An ACP stream over one WebSocket; `close` drops the socket itself and
 * `isSocketClosed` reports the transport's own verdict — true once the socket
 * is closing or closed, i.e. once nothing pending on it can ever be answered.
 */
export type WebSocketStream = Stream & {
  close: () => void;
  isSocketClosed: () => boolean;
};

export function createWebSocketStream(wsUrl: string): WebSocketStream {
  const ws = new WebSocket(wsUrl);
  const ids = createRequestIdSpace(nextConnectionEpoch());

  const incoming: AnyMessage[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;

  function pushMessage(msg: AnyMessage): void {
    incoming.push(msg);
    const waiter = waiters.shift();
    if (waiter) waiter();
  }

  function waitForMessage(): Promise<void> {
    if (incoming.length > 0 || closed) return Promise.resolve();
    return new Promise<void>((resolve) => waiters.push(resolve));
  }

  const openPromise = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener(
      "error",
      (event) => {
        reject(new Error(`WebSocket connection failed: ${event}`));
      },
      { once: true },
    );
  });

  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    try {
      const frame: unknown = JSON.parse(event.data);
      // The host batches history into bounded JSON-RPC arrays. The SDK still
      // receives ordinary messages, in wire order, before the load response.
      for (const entry of Array.isArray(frame) ? frame : [frame]) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          continue;
        }
        const msg = entry as AnyMessage;
        acpDebug("WS → client", msg);
        const mapped = ids.fromWire(msg);
        if (!mapped) {
          console.warn(
            "[acp] Dropped a reply addressed to a request of another connection",
            "id" in msg ? msg.id : undefined,
          );
          continue;
        }
        pushMessage(mapped);
      }
    } catch {
      // ignore malformed JSON
    }
  });

  ws.addEventListener("close", () => {
    closed = true;
    for (const waiter of waiters) waiter();
    waiters.length = 0;
  });

  ws.addEventListener("error", () => {
    closed = true;
    for (const waiter of waiters) waiter();
    waiters.length = 0;
  });

  const readable = new ReadableStream<AnyMessage>({
    async pull(controller) {
      await waitForMessage();
      for (const message of incoming) {
        controller.enqueue(message);
      }
      incoming.length = 0;
      if (closed && incoming.length === 0) {
        controller.close();
      }
    },
  });

  const writable = new WritableStream<AnyMessage>({
    async write(msg) {
      await openPromise;
      acpDebug("WS → agent", msg);
      ws.send(JSON.stringify(ids.toWire(msg)));
    },
    close() {
      ws.close();
    },
    abort() {
      ws.close();
    },
  });

  return {
    readable,
    writable,
    close: () => ws.close(),
    isSocketClosed: () =>
      ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED,
  };
}
