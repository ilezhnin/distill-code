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
