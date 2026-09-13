import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  createWebSocketStream: vi.fn(),
  initialize: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("../createWebSocketStream", () => ({
  createWebSocketStream: (...args: unknown[]) =>
    mocks.createWebSocketStream(...args),
}));

vi.mock("../hostClient", () => ({
  HostClient: class FakeHostClient {
    closed: Promise<void>;
    resolveClosed!: () => void;
    constructor(
      _toClient: unknown,
      readonly stream: unknown,
    ) {
      this.closed = new Promise<void>((resolve) => {
        this.resolveClosed = resolve;
      });
    }
    initialize(...args: unknown[]) {
      return mocks.initialize(...args);
    }
  },
}));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function fakeStream() {
  return {
    readable: {},
    writable: {},
    close: vi.fn(),
  };
}

async function importConnection() {
  return import("../acpConnection");
}

describe("acpConnection liveness after a timed-out request", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.invoke.mockResolvedValue("ws://127.0.0.1:1/acp");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the socket when the host still answers", async () => {
    const stream = fakeStream();
    mocks.createWebSocketStream.mockReturnValue(stream);
    mocks.initialize.mockResolvedValue({ protocolVersion: 1 });
    const connection = await importConnection();
    const client = await connection.getClient();

    await expect(
      connection.invalidateClientConnectionIfUnresponsive(),
    ).resolves.toBe(false);

    expect(stream.close).not.toHaveBeenCalled();
    await expect(connection.getClient()).resolves.toBe(client);
    expect(mocks.initialize).toHaveBeenCalledTimes(2);
  });

  it("drops a socket that stopped answering when no prompt is pending", async () => {
    vi.useFakeTimers();
    const stream = fakeStream();
    mocks.createWebSocketStream.mockReturnValue(stream);
    mocks.initialize.mockResolvedValueOnce({ protocolVersion: 1 });
    const connection = await importConnection();
    const client = await connection.getClient();

    mocks.initialize.mockReturnValueOnce(new Promise(() => {}));
    const check = connection.invalidateClientConnectionIfUnresponsive();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(check).resolves.toBe(true);
    expect(stream.close).toHaveBeenCalledOnce();

    const nextStream = fakeStream();
    mocks.createWebSocketStream.mockReturnValue(nextStream);
    mocks.initialize.mockResolvedValueOnce({ protocolVersion: 1 });
    await expect(connection.getClient()).resolves.not.toBe(client);
  });

  // Session A is streaming on the shared socket when session B's config call
  // times out. Closing the socket would reject A's prompt with "ACP
  // connection closed" while the host keeps running A's turn, so an
  // unanswered probe is not enough while a prompt is pending.
  it("keeps the socket while a prompt is pending even when the probe fails", async () => {
    vi.useFakeTimers();
    const stream = fakeStream();
    mocks.createWebSocketStream.mockReturnValue(stream);
    mocks.initialize.mockResolvedValueOnce({ protocolVersion: 1 });
    const connection = await importConnection();
    const client = await connection.getClient();
    const prompt = deferred<{ stopReason: string }>();
    const tracked = connection.trackPendingPrompt(prompt.promise);
    expect(connection.hasPendingPrompts()).toBe(true);

    mocks.initialize.mockReturnValueOnce(new Promise(() => {}));
    const check = connection.invalidateClientConnectionIfUnresponsive();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(check).resolves.toBe(false);
    expect(stream.close).not.toHaveBeenCalled();
    await expect(connection.getClient()).resolves.toBe(client);

    prompt.resolve({ stopReason: "end_turn" });
    await tracked;
    expect(connection.hasPendingPrompts()).toBe(false);
  });

  it("drops a connection that never finished coming up", async () => {
    const stream = fakeStream();
    mocks.createWebSocketStream.mockReturnValue(stream);
    mocks.initialize.mockReturnValueOnce(new Promise(() => {}));
    const connection = await importConnection();
    const stuck = connection.getClient();
    stuck.catch(() => {});
    await Promise.resolve();

    await expect(
      connection.invalidateClientConnectionIfUnresponsive(),
    ).resolves.toBe(true);

    const nextStream = fakeStream();
    mocks.createWebSocketStream.mockReturnValue(nextStream);
    mocks.initialize.mockResolvedValueOnce({ protocolVersion: 1 });
    await expect(connection.getClient()).resolves.toBeDefined();
    expect(mocks.createWebSocketStream).toHaveBeenCalledTimes(2);
  });

  it("does nothing when no connection exists", async () => {
    const connection = await importConnection();
    await expect(
      connection.invalidateClientConnectionIfUnresponsive(),
    ).resolves.toBe(false);
    expect(mocks.initialize).not.toHaveBeenCalled();
  });
});

// The host treats the newest socket as the renderer's. An attempt that was
// superseded by an invalidation must therefore never open (or keep) a socket
// nobody holds the client of, and must never hand that client to its caller.
describe("acpConnection attempt superseded by a reconnect", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.invoke.mockResolvedValue("ws://127.0.0.1:1/acp");
    mocks.initialize.mockResolvedValue({ protocolVersion: 1 });
  });

  it("opens no socket when invalidated while the host URL is still resolving", async () => {
    const url = deferred<string>();
    mocks.invoke.mockReturnValueOnce(url.promise);
    const connection = await importConnection();
    const pending = connection.getClient();
    await Promise.resolve();
    expect(mocks.createWebSocketStream).not.toHaveBeenCalled();

    await connection.invalidateClientConnection();

    const stream = fakeStream();
    mocks.createWebSocketStream.mockReturnValue(stream);
    url.resolve("ws://127.0.0.1:1/acp");

    const client = await pending;
    // One socket total: the superseded attempt never created its own.
    expect(mocks.createWebSocketStream).toHaveBeenCalledTimes(1);
    expect(stream.close).not.toHaveBeenCalled();
    await expect(connection.getClient()).resolves.toBe(client);
  });

  it("closes the superseded socket and returns the live client when invalidated mid-handshake", async () => {
    const orphan = fakeStream();
    mocks.createWebSocketStream.mockReturnValueOnce(orphan);
    const handshake = deferred<{ protocolVersion: number }>();
    mocks.initialize.mockReturnValueOnce(handshake.promise);
    const connection = await importConnection();
    const pending = connection.getClient();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.createWebSocketStream).toHaveBeenCalledTimes(1);

    await connection.invalidateClientConnection();

    const live = fakeStream();
    mocks.createWebSocketStream.mockReturnValue(live);
    handshake.resolve({ protocolVersion: 1 });

    const client = await pending;
    expect(orphan.close).toHaveBeenCalled();
    expect(live.close).not.toHaveBeenCalled();
    // The caller gets the reconnect's client, not the orphan's.
    await expect(connection.getClient()).resolves.toBe(client);
  });
});
