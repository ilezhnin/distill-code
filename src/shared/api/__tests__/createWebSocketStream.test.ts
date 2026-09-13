import type { AnyMessage } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRequestIdSpace,
  createWebSocketStream,
} from "../createWebSocketStream";

describe("createRequestIdSpace", () => {
  const ids = createRequestIdSpace("abc.3");

  it("prefixes this side's request ids with the connection epoch", () => {
    expect(
      ids.toWire({ jsonrpc: "2.0", id: 7, method: "session/prompt" }),
    ).toEqual({ jsonrpc: "2.0", id: "abc.3:7", method: "session/prompt" });
  });

  it("leaves replies to the host's own requests and notifications alone", () => {
    const reply: AnyMessage = { jsonrpc: "2.0", id: 42, result: null };
    const notification: AnyMessage = {
      jsonrpc: "2.0",
      method: "session/cancel",
    };
    expect(ids.toWire(reply)).toBe(reply);
    expect(ids.toWire(notification)).toBe(notification);
  });

  it("maps a reply for this connection back to the SDK's id", () => {
    expect(
      ids.fromWire({ jsonrpc: "2.0", id: "abc.3:7", result: { ok: true } }),
    ).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
  });

  // Old socket: id 7 was chat A's `session/prompt`. The renderer reconnects
  // and numbers from 0 again; the host finishes A's turn and answers on the
  // new socket. That reply must not resolve the new connection's request 7.
  it("drops a reply that answers another connection's request", () => {
    expect(
      ids.fromWire({ jsonrpc: "2.0", id: "abc.2:7", result: {} }),
    ).toBeNull();
    expect(ids.fromWire({ jsonrpc: "2.0", id: 7, result: {} })).toBeNull();
    expect(
      ids.fromWire({ jsonrpc: "2.0", id: "abc.3:x", result: {} }),
    ).toBeNull();
  });

  it("passes host-originated requests and notifications through", () => {
    const request: AnyMessage = {
      jsonrpc: "2.0",
      id: 3,
      method: "session/request_permission",
    };
    const notification: AnyMessage = {
      jsonrpc: "2.0",
      method: "session/update",
    };
    expect(ids.fromWire(request)).toBe(request);
    expect(ids.fromWire(notification)).toBe(notification);
  });
});

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.dispatchEvent(new Event("close"));
  }
  open() {
    this.dispatchEvent(new Event("open"));
  }
  receive(message: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  }
}

describe("createWebSocketStream request ids", () => {
  const RealWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.WebSocket = RealWebSocket;
  });

  async function nextMessage(
    reader: ReadableStreamDefaultReader<AnyMessage>,
  ): Promise<AnyMessage> {
    const { value } = await reader.read();
    if (!value) throw new Error("stream ended");
    return value;
  }

  it("gives every connection its own id space and drops a stale reply", async () => {
    const first = createWebSocketStream("ws://host/acp");
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.open();
    const firstWriter = first.writable.getWriter();
    await firstWriter.write({
      jsonrpc: "2.0",
      id: 7,
      method: "session/prompt",
    });
    const firstWireId = (JSON.parse(firstSocket.sent[0]) as { id: string }).id;
    expect(firstWireId).toMatch(/:7$/);

    const second = createWebSocketStream("ws://host/acp");
    const secondSocket = FakeWebSocket.instances[1];
    secondSocket.open();
    const secondWriter = second.writable.getWriter();
    await secondWriter.write({ jsonrpc: "2.0", id: 7, method: "session/load" });
    const secondWireId = (JSON.parse(secondSocket.sent[0]) as { id: string })
      .id;
    expect(secondWireId).toMatch(/:7$/);
    expect(secondWireId).not.toBe(firstWireId);

    const reader = second.readable.getReader();
    // The old prompt's reply lands on the newest socket, then the real one.
    secondSocket.receive({
      jsonrpc: "2.0",
      id: firstWireId,
      result: { stopReason: "end_turn" },
    });
    secondSocket.receive({
      jsonrpc: "2.0",
      id: secondWireId,
      result: { sessionId: "s" },
    });

    await expect(nextMessage(reader)).resolves.toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { sessionId: "s" },
    });
  });

  it("echoes the host's request ids back untouched", async () => {
    const stream = createWebSocketStream("ws://host/acp");
    const socket = FakeWebSocket.instances[0];
    socket.open();
    const reader = stream.readable.getReader();
    socket.receive({
      jsonrpc: "2.0",
      id: 12,
      method: "session/request_permission",
      params: {},
    });
    await expect(nextMessage(reader)).resolves.toMatchObject({ id: 12 });

    const writer = stream.writable.getWriter();
    await writer.write({ jsonrpc: "2.0", id: 12, result: { outcome: {} } });
    expect(JSON.parse(socket.sent[0])).toMatchObject({ id: 12 });
  });
});
