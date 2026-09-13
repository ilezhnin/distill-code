import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  createWebSocketStream: vi.fn(),
  initialize: vi.fn(),
  logRendererEvent: vi.fn(),
}));

vi.mock("../rendererLog", () => ({
  logRendererEvent: (...args: unknown[]) => mocks.logRendererEvent(...args),
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

function fakeStream(socketClosed = false) {
  return {
    readable: {},
    writable: {},
    close: vi.fn(),
    isSocketClosed: vi.fn(() => socketClosed),
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

  // Nothing aborts an in-flight `client.prompt`, so a prompt on a socket that
  // is really dead never settles and the pending count never drops. The
  // transport's own verdict overrides it: otherwise the socket could never be
  // replaced and every later request on it would hang too.
  it("drops a socket the transport reports closed even while a prompt is pending", async () => {
    vi.useFakeTimers();
    const stream = fakeStream(true);
    mocks.createWebSocketStream.mockReturnValue(stream);
    mocks.initialize.mockResolvedValueOnce({ protocolVersion: 1 });
    const connection = await importConnection();
    const client = await connection.getClient();
    const prompt = deferred<{ stopReason: string }>();
    void connection.trackPendingPrompt(prompt.promise);

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

  // The host task serving the socket stops answering while a turn is in
  // flight. The first unanswered probe defers to the pending prompt; the
  // second one is the bound, or the socket would be kept forever.
  it("drops a socket whose probe went unanswered twice while a prompt is pending", async () => {
    vi.useFakeTimers();
    const stream = fakeStream();
    mocks.createWebSocketStream.mockReturnValue(stream);
    mocks.initialize.mockResolvedValueOnce({ protocolVersion: 1 });
    const connection = await importConnection();
    await connection.getClient();
    const prompt = deferred<{ stopReason: string }>();
    void connection.trackPendingPrompt(prompt.promise);

    mocks.initialize.mockReturnValueOnce(new Promise(() => {}));
    const first = connection.invalidateClientConnectionIfUnresponsive();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(first).resolves.toBe(false);
    expect(stream.close).not.toHaveBeenCalled();

    mocks.initialize.mockReturnValueOnce(new Promise(() => {}));
    const second = connection.invalidateClientConnectionIfUnresponsive();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(second).resolves.toBe(true);
    expect(stream.close).toHaveBeenCalledOnce();
  });

  // One hung bridge call between two healthy ones must not add up to a
  // reconnect: an answered probe proves the transport and resets the count.
  it("forgets an unanswered probe once the host answers again", async () => {
    vi.useFakeTimers();
    const stream = fakeStream();
    mocks.createWebSocketStream.mockReturnValue(stream);
    mocks.initialize.mockResolvedValueOnce({ protocolVersion: 1 });
    const connection = await importConnection();
    await connection.getClient();
    const prompt = deferred<{ stopReason: string }>();
    void connection.trackPendingPrompt(prompt.promise);

    mocks.initialize.mockReturnValueOnce(new Promise(() => {}));
    const failing = connection.invalidateClientConnectionIfUnresponsive();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(failing).resolves.toBe(false);

    mocks.initialize.mockResolvedValueOnce({ protocolVersion: 1 });
    await expect(
      connection.invalidateClientConnectionIfUnresponsive(),
    ).resolves.toBe(false);

    mocks.initialize.mockReturnValueOnce(new Promise(() => {}));
    const again = connection.invalidateClientConnectionIfUnresponsive();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(again).resolves.toBe(false);
    expect(stream.close).not.toHaveBeenCalled();
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

// No screen in the app asks the operator about a tool call, so the answer this
// function picks IS the app's permission policy. An "always" answer rewrites
// the harness's own saved permissions for every future session, and nothing in
// the app can take it back.
describe("permission requests the renderer answers on its own", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  function request(kinds: string[]) {
    return {
      sessionId: "acp-session-1234",
      toolCall: { toolCallId: "call-1", title: "Bash(rm -rf /)" },
      options: kinds.map((kind) => ({
        optionId: `${kind}-id`,
        name: kind,
        kind,
      })),
    } as never;
  }

  it("takes the one-time allow when the harness offers one", async () => {
    const { answerPermissionRequest } = await importConnection();

    expect(
      answerPermissionRequest(
        request(["allow_once", "allow_always", "reject_once"]),
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "allow_once-id" } });
  });

  it("refuses once rather than whitelisting a tool forever", async () => {
    const { answerPermissionRequest } = await importConnection();

    expect(
      answerPermissionRequest(request(["allow_always", "reject_once"])),
    ).toEqual({ outcome: { outcome: "selected", optionId: "reject_once-id" } });
  });

  it("cancels when every offered option is permanent", async () => {
    const { answerPermissionRequest } = await importConnection();

    expect(
      answerPermissionRequest(request(["allow_always", "reject_always"])),
    ).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("logs what it answered, since nothing else records it", async () => {
    const { answerPermissionRequest } = await importConnection();

    answerPermissionRequest(request(["allow_always", "reject_once"]));

    const [level, message] = mocks.logRendererEvent.mock.calls[0] ?? [];
    expect(level).toBe("warn");
    expect(message).toContain("Bash(rm -rf /)");
    expect(message).toContain("answer=reject_once");
    expect(message).toContain("offered=[allow_always,reject_once]");
  });
});
