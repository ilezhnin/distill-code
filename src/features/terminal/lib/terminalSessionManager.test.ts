import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalEvent } from "../api/terminal";

const mocks = vi.hoisted(() => ({
  resizeTerminal: vi.fn(() => Promise.resolve()),
  startTerminal: vi.fn(),
  stopTerminal: vi.fn(() => Promise.resolve()),
  terminalWriteCallbacks: [] as (() => void)[],
  writeTerminal: vi.fn(() => Promise.resolve()),
}));

class FakeTerminal {
  cols = 80;
  rows = 24;
  element: HTMLElement | null = null;
  options: { theme?: unknown; fontFamily?: string } = {};

  clear() {}
  dispose() {}
  focus = vi.fn();
  loadAddon(addon: { activate?: (terminal: FakeTerminal) => void }) {
    addon.activate?.(this);
  }
  onData() {
    return { dispose: vi.fn() };
  }
  open(container: HTMLElement) {
    this.element = document.createElement("div");
    container.appendChild(this.element);
  }
  refresh() {}
  write = vi.fn((_data: string, callback?: () => void) => {
    if (callback) {
      mocks.terminalWriteCallbacks.push(callback);
    }
  });
  writeln = vi.fn();
}

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: FakeTerminal,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    activate() {}
    fit() {}
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    activate() {}
  },
}));

vi.mock("../api/terminal", () => mocks);

const labels = {
  exitedWithSignal: (signal: string) => `exited ${signal}`,
  startFailed: "failed",
  stopped: "stopped",
};

function mockAnimationFrames() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextId;
    nextId += 1;
    callbacks.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    callbacks.delete(id);
  });

  return {
    runAll: () => {
      while (callbacks.size > 0) {
        const next = callbacks.entries().next().value;
        if (!next) {
          return;
        }
        const [id, callback] = next;
        callbacks.delete(id);
        callback(performance.now());
      }
    },
  };
}

describe("terminalSessionManager", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    mocks.resizeTerminal.mockClear();
    mocks.startTerminal.mockReset();
    mocks.stopTerminal.mockClear();
    mocks.terminalWriteCallbacks = [];
    mocks.writeTerminal.mockClear();
    document.getElementById("goose-terminal-parking-root")?.remove();
  });

  it("clears queued commands when a starting terminal session is stopped", async () => {
    const { getOrCreateTerminalSession, queueTerminalCommand } = await import(
      "./terminalSessionManager"
    );
    let resolveFirstStart: (terminalId: string) => void = () => undefined;
    mocks.startTerminal.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFirstStart = resolve;
        }),
    );
    mocks.startTerminal.mockResolvedValueOnce("terminal-2");

    queueTerminalCommand("session:/repo", "pnpm test");
    const firstSession = getOrCreateTerminalSession({
      key: "session:/repo",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });

    firstSession.stop();
    resolveFirstStart("terminal-1");
    await Promise.resolve();

    getOrCreateTerminalSession({
      key: "session:/repo",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    await Promise.resolve();

    expect(mocks.writeTerminal).not.toHaveBeenCalledWith(
      "terminal-2",
      "pnpm test\r",
    );
  });

  it("clears queued commands when an unmounted tab session is stopped", async () => {
    const {
      getOrCreateTerminalSession,
      queueTerminalCommand,
      stopTerminalSession,
    } = await import("./terminalSessionManager");
    mocks.startTerminal.mockResolvedValueOnce("terminal-1");

    queueTerminalCommand("chat-session-id:tab-1", "pnpm test");

    expect(stopTerminalSession("chat-session-id:tab-1")).toBe(false);

    getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    await Promise.resolve();

    expect(mocks.writeTerminal).not.toHaveBeenCalledWith(
      "terminal-1",
      "pnpm test\r",
    );
  });

  it("stops an existing tab session through the helper", async () => {
    const { getOrCreateTerminalSession, stopTerminalSession } = await import(
      "./terminalSessionManager"
    );
    mocks.startTerminal.mockResolvedValueOnce("terminal-1");

    getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    await Promise.resolve();

    expect(
      stopTerminalSession("chat-session-id:tab-1", { writeStopped: true }),
    ).toBe(true);
    expect(mocks.stopTerminal).toHaveBeenCalledWith("terminal-1");
  });

  it("restarts an existing tab session through the helper", async () => {
    const { getOrCreateTerminalSession, restartTerminalSession } = await import(
      "./terminalSessionManager"
    );
    mocks.startTerminal.mockResolvedValueOnce("terminal-1");
    mocks.startTerminal.mockResolvedValueOnce("terminal-2");

    getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    await Promise.resolve();

    expect(restartTerminalSession("chat-session-id:tab-1")).toBe(true);

    expect(mocks.stopTerminal).toHaveBeenCalledWith("terminal-1");
    expect(mocks.startTerminal).toHaveBeenCalledTimes(2);
  });

  it("notifies session status subscribers when the backend exits", async () => {
    const changes: unknown[] = [];
    let emitTerminalEvent: (event: TerminalEvent) => void = () => undefined;
    const { getOrCreateTerminalSession, subscribeTerminalSessionStatus } =
      await import("./terminalSessionManager");
    mocks.startTerminal.mockImplementationOnce(({ onEvent }) => {
      emitTerminalEvent = onEvent;
      return Promise.resolve("terminal-1");
    });

    subscribeTerminalSessionStatus("chat-session-id:tab-1", (change) => {
      changes.push(change);
    });
    getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    await Promise.resolve();

    emitTerminalEvent({
      event: "exited",
      data: { terminalId: "terminal-1", exitCode: 0, signal: null },
    });

    expect(changes).toContainEqual({
      key: "chat-session-id:tab-1",
      status: "exited",
      previousStatus: "running",
      source: "backend-exit",
    });
  });

  it("keeps a shell that exited before the start reply marked as exited", async () => {
    const { getOrCreateTerminalSession } = await import(
      "./terminalSessionManager"
    );
    let resolveStart: (terminalId: string) => void = () => undefined;
    mocks.startTerminal.mockImplementationOnce(({ onEvent }) => {
      return new Promise<string>((resolve) => {
        onEvent({ event: "started", data: { terminalId: "terminal-1" } });
        onEvent({
          event: "exited",
          data: { terminalId: "terminal-1", exitCode: 1, signal: null },
        });
        resolveStart = resolve;
      });
    });
    mocks.startTerminal.mockResolvedValueOnce("terminal-2");
    const session = getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });

    resolveStart("terminal-1");
    await Promise.resolve();
    await Promise.resolve();

    expect(session.status).toBe("exited");

    session.runCommand("ls");
    expect(mocks.startTerminal).toHaveBeenCalledTimes(2);
    expect(mocks.writeTerminal).not.toHaveBeenCalledWith("terminal-1", "ls\r");
  });

  it("stops backend shells when the page is torn down", async () => {
    const { getOrCreateTerminalSession, getTerminalSessionStatus } =
      await import("./terminalSessionManager");
    mocks.startTerminal.mockResolvedValueOnce("terminal-pagehide");
    getOrCreateTerminalSession({
      key: "chat-session-id:tab-pagehide",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    await Promise.resolve();

    window.dispatchEvent(new Event("pagehide"));

    expect(mocks.stopTerminal).toHaveBeenCalledWith("terminal-pagehide");
    expect(getTerminalSessionStatus("chat-session-id:tab-pagehide")).toBeNull();
  });

  it("keeps pre-session status subscriptions for later backend exits", async () => {
    const changes: unknown[] = [];
    let emitTerminalEvent: (event: TerminalEvent) => void = () => undefined;
    const { getOrCreateTerminalSession, subscribeTerminalSessionStatus } =
      await import("./terminalSessionManager");
    mocks.startTerminal.mockImplementationOnce(({ onEvent }) => {
      emitTerminalEvent = onEvent;
      return Promise.resolve("terminal-1");
    });

    subscribeTerminalSessionStatus("session:later-tab", (change) => {
      changes.push(change);
    });

    getOrCreateTerminalSession({
      key: "session:later-tab",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    await Promise.resolve();

    emitTerminalEvent({
      event: "exited",
      data: { terminalId: "terminal-1", exitCode: 0, signal: null },
    });

    expect(changes).toContainEqual(
      expect.objectContaining({
        key: "session:later-tab",
        status: "exited",
        source: "backend-exit",
      }),
    );
  });

  it("emits client-stop when a tab session is explicitly stopped", async () => {
    const changes: unknown[] = [];
    const {
      getOrCreateTerminalSession,
      stopTerminalSession,
      subscribeTerminalSessionStatus,
    } = await import("./terminalSessionManager");
    mocks.startTerminal.mockResolvedValueOnce("terminal-1");

    getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    await Promise.resolve();

    subscribeTerminalSessionStatus("chat-session-id:tab-1", (change) => {
      changes.push(change);
    });

    stopTerminalSession("chat-session-id:tab-1", { writeStopped: true });

    expect(changes).toContainEqual({
      key: "chat-session-id:tab-1",
      status: "exited",
      previousStatus: "running",
      source: "client-stop",
    });
  });

  it("parks a stable xterm host outside the unmounting container when detached", async () => {
    const { getOrCreateTerminalSession } = await import(
      "./terminalSessionManager"
    );
    mocks.startTerminal.mockResolvedValueOnce("terminal-1");
    const firstContainer = document.createElement("div");
    const secondContainer = document.createElement("div");
    const session = getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });

    const detach = session.attach(firstContainer);
    const host = firstContainer.firstElementChild;
    const element = host?.firstElementChild;
    expect(host).toBeTruthy();
    expect(element).toBeTruthy();

    detach();

    expect(firstContainer).toBeEmptyDOMElement();
    expect(host?.parentElement).toBe(
      document.getElementById("goose-terminal-parking-root"),
    );

    session.attach(secondContainer);

    expect(secondContainer.firstElementChild).toBe(host);
    expect(host?.firstElementChild).toBe(element);
  });

  it("does not focus xterm while attaching a visible terminal", async () => {
    const { getOrCreateTerminalSession } = await import(
      "./terminalSessionManager"
    );
    mocks.startTerminal.mockResolvedValueOnce("terminal-1");
    const session = getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });

    session.attach(document.createElement("div"));

    expect(session.terminal.focus).not.toHaveBeenCalled();
  });

  it("returns terminal status snapshots", async () => {
    const { getOrCreateTerminalSession, getTerminalSessionStatus } =
      await import("./terminalSessionManager");
    mocks.startTerminal.mockResolvedValueOnce("terminal-1");

    expect(getTerminalSessionStatus("chat-session-id:tab-1")).toBeNull();

    getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });

    expect(getTerminalSessionStatus("chat-session-id:tab-1")).toBe("starting");

    await Promise.resolve();

    expect(getTerminalSessionStatus("chat-session-id:tab-1")).toBe("running");
  });

  it("tracks chat sessions that have visible terminal state", async () => {
    const {
      getChatSessionIdsWithTerminals,
      getOrCreateTerminalSession,
      stopTerminalSession,
      subscribeTerminalSessionRegistry,
    } = await import("./terminalSessionManager");
    const snapshots: string[][] = [];
    mocks.startTerminal.mockResolvedValueOnce("terminal-1");

    const unsubscribe = subscribeTerminalSessionRegistry(() => {
      snapshots.push(Array.from(getChatSessionIdsWithTerminals()));
    });

    getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });

    expect(getChatSessionIdsWithTerminals()).toEqual(
      new Set(["chat-session-id"]),
    );
    await Promise.resolve();
    expect(getChatSessionIdsWithTerminals()).toEqual(
      new Set(["chat-session-id"]),
    );

    stopTerminalSession("chat-session-id:tab-1");
    expect(getChatSessionIdsWithTerminals()).toEqual(new Set());
    expect(snapshots).toEqual([["chat-session-id"], []]);

    unsubscribe();
  });

  it("carries a draft chat's terminals over to the promoted session id", async () => {
    // A draft chat gets its backend id after acpCreateSession resolves. The
    // terminal panel then re-keys to `${backendId}:${tab}`; without a remap
    // that is a map miss, a second shell, and the first PTY left running
    // under a key nothing can reach.
    const {
      getChatSessionIdsWithTerminals,
      getOrCreateTerminalSession,
      getTerminalSessionStatus,
      queueTerminalCommand,
      renameTerminalSessionPrefix,
      subscribeTerminalSessionStatus,
    } = await import("./terminalSessionManager");
    let emitTerminalEvent: (event: TerminalEvent) => void = () => undefined;
    let resolveStart: (terminalId: string) => void = () => undefined;
    mocks.startTerminal.mockImplementationOnce(
      ({ onEvent }) =>
        new Promise<string>((resolve) => {
          emitTerminalEvent = onEvent;
          resolveStart = resolve;
        }),
    );

    const draftSession = getOrCreateTerminalSession({
      key: "draft-1:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    queueTerminalCommand("draft-1:tab-1", "pnpm dev");
    const statuses: string[] = [];
    subscribeTerminalSessionStatus("draft-1:tab-1", (change) => {
      statuses.push(`${change.key}:${change.status}`);
    });

    renameTerminalSessionPrefix("draft-1", "backend-1");

    // The same session answers under the new key, and the old one is gone.
    const promoted = getOrCreateTerminalSession({
      key: "backend-1:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    expect(promoted).toBe(draftSession);
    expect(promoted.key).toBe("backend-1:tab-1");
    expect(mocks.startTerminal).toHaveBeenCalledTimes(1);
    expect(getTerminalSessionStatus("draft-1:tab-1")).toBeNull();
    expect(getTerminalSessionStatus("backend-1:tab-1")).toBe("starting");
    expect(getChatSessionIdsWithTerminals()).toEqual(new Set(["backend-1"]));

    // Queued commands and status subscriptions follow the session.
    resolveStart("terminal-1");
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.writeTerminal).toHaveBeenCalledWith(
      "terminal-1",
      "pnpm dev\r",
    );
    expect(statuses).toEqual(["backend-1:tab-1:running"]);

    emitTerminalEvent({
      event: "exited",
      data: { terminalId: "terminal-1", exitCode: 0, signal: null },
    });
    expect(statuses).toEqual([
      "backend-1:tab-1:running",
      "backend-1:tab-1:exited",
    ]);
    expect(mocks.stopTerminal).not.toHaveBeenCalled();
  });

  it("stops every terminal of one chat and leaves the others alone", async () => {
    const {
      getChatSessionIdsWithTerminals,
      getOrCreateTerminalSession,
      queueTerminalCommand,
      stopTerminalSessionsForChat,
    } = await import("./terminalSessionManager");
    mocks.startTerminal
      .mockResolvedValueOnce("terminal-1")
      .mockResolvedValueOnce("terminal-2")
      .mockResolvedValueOnce("terminal-3");

    for (const key of ["chat-a:tab-1", "chat-a:tab-2", "chat-b:tab-1"]) {
      getOrCreateTerminalSession({
        key,
        cwd: "/repo",
        labels,
        theme: {},
        fontFamily: "monospace",
      });
    }
    await Promise.resolve();
    queueTerminalCommand("chat-a:tab-3", "pnpm dev");
    mocks.startTerminal.mockResolvedValueOnce("terminal-4");

    expect(stopTerminalSessionsForChat("chat-a")).toBe(2);

    expect(mocks.stopTerminal).toHaveBeenCalledWith("terminal-1");
    expect(mocks.stopTerminal).toHaveBeenCalledWith("terminal-2");
    expect(mocks.stopTerminal).not.toHaveBeenCalledWith("terminal-3");
    expect(getChatSessionIdsWithTerminals()).toEqual(new Set(["chat-b"]));

    // The command queued for a tab that had not started yet is gone too.
    getOrCreateTerminalSession({
      key: "chat-a:tab-3",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    await Promise.resolve();
    expect(mocks.writeTerminal).not.toHaveBeenCalledWith(
      "terminal-4",
      "pnpm dev\r",
    );
  });

  it("keeps errored terminals in the chat-session terminal registry", async () => {
    const { getChatSessionIdsWithTerminals, getOrCreateTerminalSession } =
      await import("./terminalSessionManager");
    mocks.startTerminal.mockRejectedValueOnce(new Error("no shell"));

    getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });

    await Promise.resolve();

    expect(getChatSessionIdsWithTerminals()).toEqual(
      new Set(["chat-session-id"]),
    );
  });

  it("drains terminal output on animation frames after xterm parses the previous chunk", async () => {
    const frames = mockAnimationFrames();
    let emitTerminalEvent: (event: TerminalEvent) => void = () => undefined;
    const { getOrCreateTerminalSession } = await import(
      "./terminalSessionManager"
    );
    mocks.startTerminal.mockImplementationOnce(({ onEvent }) => {
      emitTerminalEvent = onEvent;
      return Promise.resolve("terminal-1");
    });
    const session = getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    session.attach(document.createElement("div"));
    await Promise.resolve();

    emitTerminalEvent({
      event: "output",
      data: { terminalId: "terminal-1", data: "a" },
    });
    emitTerminalEvent({
      event: "output",
      data: { terminalId: "terminal-1", data: "b" },
    });

    expect(session.terminal.write).not.toHaveBeenCalled();

    frames.runAll();

    expect(session.terminal.write).toHaveBeenCalledTimes(1);
    expect(session.terminal.write).toHaveBeenCalledWith(
      "ab",
      expect.anything(),
    );

    emitTerminalEvent({
      event: "output",
      data: { terminalId: "terminal-1", data: "c" },
    });

    frames.runAll();

    expect(session.terminal.write).toHaveBeenCalledTimes(1);

    mocks.terminalWriteCallbacks.shift()?.();

    frames.runAll();

    expect(session.terminal.write).toHaveBeenCalledTimes(2);
    expect(session.terminal.write).toHaveBeenLastCalledWith(
      "c",
      expect.anything(),
    );
  });

  it("queues terminal output while detached and resumes draining after attach", async () => {
    const frames = mockAnimationFrames();
    let emitTerminalEvent: (event: TerminalEvent) => void = () => undefined;
    const { getOrCreateTerminalSession } = await import(
      "./terminalSessionManager"
    );
    mocks.startTerminal.mockImplementationOnce(({ onEvent }) => {
      emitTerminalEvent = onEvent;
      return Promise.resolve("terminal-1");
    });
    const session = getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    const detach = session.attach(document.createElement("div"));
    await Promise.resolve();
    detach();

    emitTerminalEvent({
      event: "output",
      data: { terminalId: "terminal-1", data: "detached output" },
    });
    frames.runAll();

    expect(session.terminal.write).not.toHaveBeenCalled();

    session.attach(document.createElement("div"));
    frames.runAll();

    expect(session.terminal.write).toHaveBeenCalledWith(
      "detached output",
      expect.anything(),
    );
  });

  it("keeps only the newest output of a parked terminal that never stops talking", async () => {
    const frames = mockAnimationFrames();
    let emitTerminalEvent: (event: TerminalEvent) => void = () => undefined;
    const { getOrCreateTerminalSession } = await import(
      "./terminalSessionManager"
    );
    mocks.startTerminal.mockImplementationOnce(({ onEvent }) => {
      emitTerminalEvent = onEvent;
      return Promise.resolve("terminal-1");
    });
    const session = getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    const detach = session.attach(document.createElement("div"));
    await Promise.resolve();
    detach();

    // 1.5 MB of chatty output while parked: the 1 MB buffer overflows and the
    // oldest chunks are dropped a chunk at a time.
    const chunk = "x".repeat(10_000);
    emitTerminalEvent({
      event: "output",
      data: { terminalId: "terminal-1", data: "OLDEST" },
    });
    for (let index = 0; index < 150; index++) {
      emitTerminalEvent({
        event: "output",
        data: { terminalId: "terminal-1", data: chunk },
      });
    }
    emitTerminalEvent({
      event: "output",
      data: { terminalId: "terminal-1", data: "NEWEST" },
    });

    session.attach(document.createElement("div"));
    let drained = "";
    let consumedWrites = 0;
    for (let pass = 0; pass < 60; pass++) {
      frames.runAll();
      const writes = vi.mocked(session.terminal.write).mock.calls;
      if (writes.length === consumedWrites) break;
      for (; consumedWrites < writes.length; consumedWrites++) {
        drained += writes[consumedWrites]?.[0] ?? "";
      }
      mocks.terminalWriteCallbacks.shift()?.();
    }

    expect(drained.length).toBe(1_000_000);
    expect(drained.startsWith("OLDEST")).toBe(false);
    expect(drained.endsWith("NEWEST")).toBe(true);
  });

  it("buffers terminal output while rendering is suspended and resumes after", async () => {
    const frames = mockAnimationFrames();
    let emitTerminalEvent: (event: TerminalEvent) => void = () => undefined;
    const { getOrCreateTerminalSession, setTerminalRenderingSuspended } =
      await import("./terminalSessionManager");
    mocks.startTerminal.mockImplementationOnce(({ onEvent }) => {
      emitTerminalEvent = onEvent;
      return Promise.resolve("terminal-1");
    });
    const session = getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    session.attach(document.createElement("div"));
    await Promise.resolve();

    setTerminalRenderingSuspended(true);
    emitTerminalEvent({
      event: "output",
      data: { terminalId: "terminal-1", data: "suspended output" },
    });
    frames.runAll();

    expect(session.terminal.write).not.toHaveBeenCalled();

    setTerminalRenderingSuspended(false);
    frames.runAll();

    expect(session.terminal.write).toHaveBeenCalledWith(
      "suspended output",
      expect.anything(),
    );
  });
});
