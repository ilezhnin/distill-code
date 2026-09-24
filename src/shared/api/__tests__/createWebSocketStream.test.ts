import type { AnyMessage } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebSocketStream } from "../createWebSocketStream";

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

  it("expands replay batches in order before the load response, dropping stale replies individually", async () => {
    const stream = createWebSocketStream("ws://host/acp");
    const socket = FakeWebSocket.instances[0];
    socket.open();
    const writer = stream.writable.getWriter();
    await writer.write({ jsonrpc: "2.0", id: 1, method: "session/load" });
    const { id } = JSON.parse(socket.sent[0]) as { id: string };
    const notifications: AnyMessage[] = Array.from(
      { length: 300 },
      (_, index) => ({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: String(index) },
          },
        },
      }),
    );
    socket.receive(notifications.slice(0, 128));
    socket.receive([
      null,
      ...notifications.slice(128, 256),
      { jsonrpc: "2.0", id: "old:1", result: {} },
    ]);
    socket.receive(notifications.slice(256));
    socket.receive({ jsonrpc: "2.0", id, result: { done: true } });
    socket.close();
    const reader = stream.readable.getReader();
    const received: AnyMessage[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      received.push(next.value);
    }
    expect(received).toEqual([
      ...notifications,
      { jsonrpc: "2.0", id: 1, result: { done: true } },
    ]);
  });
});
