import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetForegroundQueueOwnershipForTesting } from "@/features/chat/lib/foregroundQueueOwnership";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  loadPersistedMessageQueues,
  resetRendererReloadStateForTesting,
} from "@/features/chat/stores/queuePersistence";
import {
  resetBackgroundQueueDrainStateForTesting,
  useBackgroundQueuedMessageDrain,
} from "../useBackgroundQueuedMessageDrain";

const mocks = vi.hoisted(() => ({ send: vi.fn(), invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));

vi.mock("@/features/chat/lib/queuedSessionSend", () => ({
  sendQueuedPromptToExistingSessionInBackground: (...args: unknown[]) =>
    mocks.send(...args),
}));

// What `state/message-queues.json` held for chat A when the renderer went
// away: one message the operator queued while A's agent worked.
const PERSISTED_QUEUES = JSON.stringify({
  "chat-a": [
    {
      kind: "transport-ready",
      recordId: "queued-before-reload",
      payload: { text: "next task", persona: { kind: "inherit" } },
    },
  ],
});

// The renderer's own mark that an earlier document of this window already
// read the queues (sessionStorage: kept across a reload, gone with the app).
const RENDERER_STARTED_KEY = "flock:renderer-started";

function DrainHarness() {
  useBackgroundQueuedMessageDrain();
  return null;
}

describe("a chat nobody has open, after the renderer reloaded or the app relaunched", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.__TAURI_INTERNALS__ = {} as never;
    resetRendererReloadStateForTesting();
    resetForegroundQueueOwnershipForTesting();
    resetBackgroundQueueDrainStateForTesting();
    mocks.send.mockResolvedValue(undefined);
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "load_message_queues" ? PERSISTED_QUEUES : undefined,
    );
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: false,
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "chat-a",
          title: "Chat A",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          messageCount: 2,
          executionTarget: { harnessId: "goose" },
        },
      ],
      hasHydratedSessions: true,
    });
  });

  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    window.sessionStorage.clear();
  });

  /** Startup: read the queues back, then A's agent finishes its turn. */
  async function startAndLetTheAgentFinish() {
    // The agent of chat A is still working when the queue is read back.
    useChatStore.getState().setActiveRunId("chat-a", "run-1");
    const queues = await loadPersistedMessageQueues();
    useChatStore.getState().replaceQueuedMessages(queues);
    render(<DrainHarness />);
    await act(async () => Promise.resolve());
    act(() => useChatStore.getState().settleActiveRun("chat-a"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  }

  it("control: after an app relaunch the message waits for the operator to open the chat (today's choice, kept)", async () => {
    await startAndLetTheAgentFinish();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["chat-a"]?.[0],
    ).toMatchObject({ recordId: "queued-before-reload", restored: true });
  });

  it("marks the window as started once the queues are read, so the next document of this window knows it is a reload", async () => {
    expect(window.sessionStorage.getItem(RENDERER_STARTED_KEY)).toBeNull();
    await loadPersistedMessageQueues();
    expect(window.sessionStorage.getItem(RENDERER_STARTED_KEY)).toBe("1");
  });

  it("after a renderer reload in the same app process the message is sent when the agent finishes, without the operator opening the chat (LAWS/CHAT.md)", async () => {
    // An earlier document of this window read the queues before it died.
    window.sessionStorage.setItem(RENDERER_STARTED_KEY, "1");
    await startAndLetTheAgentFinish();
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1), {
      timeout: 500,
    }).catch(() => undefined);
    expect(
      mocks.send.mock.calls.length,
      "the queue must resume dispatching its first message once the session is ready",
    ).toBe(1);
  });
});
