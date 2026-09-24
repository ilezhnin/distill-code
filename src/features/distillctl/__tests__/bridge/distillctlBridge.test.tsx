import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DistillctlBridge } from "@/features/distillctl/bridge/DistillctlBridge";
import type { BridgeRequest } from "@/features/distillctl/bridge/distillctlPlugin";
import {
  __resetDistillctlLifecycleForTests,
  handleDistillctlRequest,
} from "@/features/distillctl/bridge/lifecycle";
import { CommandError } from "@/features/distillctl/commands/types";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  dispatchCommand: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mocks.listen(...args),
}));

// Keep TOOL_GROUPS real (the set_timeouts push derives from it); only the
// dispatch entry point is replaced.
vi.mock("@/features/distillctl/commands/registry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/distillctl/commands/registry")
    >();
  return {
    ...actual,
    dispatchCommand: (...args: unknown[]) => mocks.dispatchCommand(...args),
  };
});

type RequestHandler = (event: { payload: BridgeRequest }) => void;

let listenHandlers: RequestHandler[] = [];

function emitRequest(request: BridgeRequest): void {
  for (const handler of [...listenHandlers]) {
    handler({ payload: request });
  }
}

function invokeCalls(command: string): unknown[][] {
  return mocks.invoke.mock.calls.filter(([invoked]) => invoked === command);
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

let queryClient: QueryClient;

/** The bridge reads the app's query client (doctor-report cache sharing). */
function renderBridge(ui: ReactNode = <DistillctlBridge />): void {
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  // restoreMocks only restores vi.spyOn spies; vi.fn() mocks keep their call
  // history across tests unless cleared explicitly.
  vi.clearAllMocks();
  window.__TAURI_INTERNALS__ = {};
  localStorage.clear();
  listenHandlers = [];
  queryClient = new QueryClient();
  __resetDistillctlLifecycleForTests();

  mocks.listen.mockImplementation((_event: string, handler: RequestHandler) => {
    listenHandlers.push(handler);
    return Promise.resolve(() => {
      listenHandlers = listenHandlers.filter(
        (registered) => registered !== handler,
      );
    });
  });
  mocks.invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case "plugin:distillctl|start":
        return { port: 43210 };
      default:
        return undefined;
    }
  });
  mocks.dispatchCommand.mockResolvedValue(undefined);
});

afterEach(async () => {
  // Unmount now (instead of relying on RTL auto-cleanup ordering) and let the
  // lifecycle reconciler converge on the unmount's desired=false before
  // resetting, so no in-flight stop/start leaks into the next test.
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  __resetDistillctlLifecycleForTests();
  window.__TAURI_INTERNALS__ = undefined;
});

describe("DistillctlBridge lifecycle", () => {
  it("starts exactly once under a StrictMode double-mount", async () => {
    renderBridge(
      <StrictMode>
        <DistillctlBridge />
      </StrictMode>,
    );
    await flushAsync();

    expect(invokeCalls("plugin:distillctl|start")).toHaveLength(1);
    expect(invokeCalls("plugin:distillctl|stop")).toHaveLength(0);
  });

  it("stops a partially started broker when timeout registration fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "plugin:distillctl|start") {
        return { port: 43210 };
      }
      if (command === "plugin:distillctl|set_timeouts") {
        throw new Error("failed to register timeouts");
      }
      return undefined;
    });

    renderBridge();
    await flushAsync();
    await flushAsync();

    expect(invokeCalls("plugin:distillctl|start")).toHaveLength(1);
    expect(invokeCalls("plugin:distillctl|set_timeouts")).toHaveLength(1);
    expect(invokeCalls("plugin:distillctl|stop")).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[distillctl] failed to start broker",
      expect.any(Error),
    );
  });
});

describe("DistillctlBridge request handling", () => {
  it("dispatches a bridge request and submits an ok result", async () => {
    renderBridge();
    await flushAsync();
    mocks.dispatchCommand.mockResolvedValue({ projects: [] });

    emitRequest({
      id: "req-1",
      command: "projects",
      args: { action: "list" },
      timeoutMs: 30_000,
    });
    await flushAsync();

    expect(mocks.dispatchCommand).toHaveBeenCalledWith(
      "projects",
      { action: "list" },
      { deadlineMs: expect.any(Number) },
    );
    expect(mocks.invoke).toHaveBeenCalledWith(
      "plugin:distillctl|submit_result",
      {
        result: { id: "req-1", ok: true, data: { projects: [] } },
      },
    );
  });

  it("derives the dispatch deadline from the request's broker-resolved timeoutMs", async () => {
    // A request `timeout_ms` override changes the broker's timeout; the
    // renderer deadline must follow it, not the static per-command value.
    const now = 1_750_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    mocks.dispatchCommand.mockResolvedValue({ ok: true });

    await handleDistillctlRequest({
      id: "req-deadline",
      command: "sessions",
      args: { action: "create", prompt: "hi" },
      timeoutMs: 5_000,
    });

    expect(mocks.dispatchCommand).toHaveBeenCalledWith(
      "sessions",
      { action: "create", prompt: "hi" },
      { deadlineMs: now + 5_000 },
    );
    nowSpy.mockRestore();
  });

  it("forwards the wire actor into the command context, and only then", async () => {
    // The actor is the calling agent session's identity; commands enforce
    // the spawn ACL against it. Absent must stay absent — an anonymous call
    // is the operator, and inventing an actor would subject the operator to
    // the agent ACL.
    mocks.dispatchCommand.mockResolvedValue({ ok: true });

    await handleDistillctlRequest({
      id: "req-actor",
      command: "sessions",
      args: { action: "create", prompt: "hi" },
      timeoutMs: 5_000,
      actor: "20260830_7",
    });
    expect(mocks.dispatchCommand).toHaveBeenCalledWith(
      "sessions",
      { action: "create", prompt: "hi" },
      expect.objectContaining({ actor: "20260830_7" }),
    );

    mocks.dispatchCommand.mockClear();
    await handleDistillctlRequest({
      id: "req-anon",
      command: "sessions",
      args: { action: "create", prompt: "hi" },
      timeoutMs: 5_000,
    });
    const ctx = mocks.dispatchCommand.mock.calls[0]?.[2] as
      | Record<string, unknown>
      | undefined;
    expect(ctx && "actor" in ctx).toBe(false);
  });

  it("maps a CommandError to ok:false with its stable code", async () => {
    renderBridge();
    await flushAsync();
    mocks.dispatchCommand.mockRejectedValue(
      new CommandError("target_session_running", "Cannot archive this session"),
    );

    emitRequest({
      id: "req-2",
      command: "sessions",
      args: { action: "archive", session_id: "other" },
      timeoutMs: 60_000,
    });
    await flushAsync();

    expect(mocks.invoke).toHaveBeenCalledWith(
      "plugin:distillctl|submit_result",
      {
        result: {
          id: "req-2",
          ok: false,
          error: {
            code: "target_session_running",
            message: "Cannot archive this session",
          },
        },
      },
    );
  });
});
