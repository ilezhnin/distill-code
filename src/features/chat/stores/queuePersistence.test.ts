import { beforeEach, describe, expect, it, vi } from "vitest";
import { admitSystemInheritedQueuedMessage } from "../lib/admittedSend";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import {
  loadPersistedMessageQueues,
  flushMessageQueues,
  persistMessageQueues,
} from "./queuePersistence";
import { useChatSessionStore, type ChatSession } from "./chatSessionStore";

describe("queuePersistence", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    window.localStorage.clear();
    window.__TAURI_INTERNALS__ = {};
    useChatSessionStore.setState({ sessions: [] });
  });

  it("does not replace a failed native read with stale browser commands", async () => {
    window.localStorage.setItem("distill:chat-message-queues:v1", '{"s1":[]}');
    mockInvoke.mockRejectedValue(new Error("read denied"));
    await expect(loadPersistedMessageQueues()).rejects.toThrow("read denied");
    expect(window.localStorage.getItem("distill:chat-message-queues:v1")).toBe(
      '{"s1":[]}',
    );
  });

  it("restores an interrupted draft with its queued text and requires manual retry", async () => {
    mockInvoke.mockResolvedValue(
      JSON.stringify({
        draft: [
          {
            kind: "transport-ready",
            recordId: "unsent",
            payload: { text: "preserved prompt", persona: { kind: "inherit" } },
            draftSession: {
              id: "draft",
              title: "Draft",
              creationState: "pending",
              createdAt: "2026-09-28T00:00:00Z",
              updatedAt: "2026-09-28T00:00:00Z",
            },
          },
        ],
      }),
    );
    const queues = await loadPersistedMessageQueues();
    expect(queues.draft[0]).toMatchObject({
      restored: true,
      payload: { text: "preserved prompt" },
    });
    expect(useChatSessionStore.getState().getSession("draft")).toMatchObject({
      creationState: "failed",
      title: "Draft",
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("retains failed writes and retries them during the close flush", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("disk full"));
    persistMessageQueues(
      {
        s1: [
          {
            kind: "transport-ready",
            recordId: "r1",
            payload: admitSystemInheritedQueuedMessage({ text: "keep" }),
          },
        ],
      },
      ["s1"],
    );
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
    mockInvoke.mockResolvedValue(undefined);
    await flushMessageQueues();
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke.mock.calls[1]).toEqual(mockInvoke.mock.calls[0]);
  });

  it("loads inline image attachments from native persistence when localStorage is over quota", async () => {
    const serialized = JSON.stringify({
      s1: [
        {
          kind: "transport-ready",
          recordId: "queued-image",
          payload: {
            text: "inspect this",
            executionTarget: { harnessId: "goose" },
            attachments: [
              {
                id: "image-1",
                kind: "image",
                name: "large.png",
                mimeType: "image/png",
                base64: "bytes",
                previewUrl: "data:image/png;base64,bytes",
              },
            ],
          },
        },
      ],
    });
    mockInvoke.mockResolvedValue(serialized);
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
      });

    await expect(loadPersistedMessageQueues()).resolves.toMatchObject({
      s1: [
        {
          recordId: "queued-image",
          payload: { attachments: [{ base64: "bytes" }] },
        },
      ],
    });
    expect(mockInvoke).toHaveBeenCalledWith("load_message_queues");
    setItem.mockRestore();
  });

  it("clears ephemeral edit locks and parks restored queues until session replay", async () => {
    mockInvoke.mockResolvedValue(
      JSON.stringify({
        s1: [
          {
            kind: "transport-ready",
            recordId: "editing-record",
            payload: {
              text: "original",
              executionTarget: { harnessId: "goose" },
            },
            editing: true,
          },
        ],
      }),
    );

    const queues = await loadPersistedMessageQueues();
    expect(queues.s1?.[0]).toMatchObject({
      recordId: "editing-record",
      restored: true,
    });
    expect(queues.s1?.[0]).not.toHaveProperty("editing");
  });

  it("strips all obsolete legacy model fields while retaining records", async () => {
    mockInvoke.mockResolvedValue(
      JSON.stringify({
        s1: [
          {
            kind: "transport-ready",
            recordId: "orphan-model",
            payload: { text: "use the live target", modelId: "stale-model" },
          },
          {
            kind: "transport-ready",
            recordId: "goose-sentinel-model",
            payload: {
              text: "keep the loaded model",
              providerId: "goose",
              modelId: "gpt-5.6",
            },
          },
        ],
      }),
    );

    const queues = await loadPersistedMessageQueues();
    expect(queues.s1).toHaveLength(2);
    expect(queues.s1?.map((record) => record.payload)).toEqual([
      { text: "use the live target", persona: { kind: "inherit" } },
      { text: "keep the loaded model", persona: { kind: "inherit" } },
    ]);
  });

  it("keeps a record's run settings and drops malformed ones without losing the message", async () => {
    mockInvoke.mockResolvedValue(
      JSON.stringify({
        s1: [
          {
            kind: "transport-ready",
            recordId: "with-settings",
            payload: {
              text: "fast and deep",
              persona: { kind: "inherit" },
              runSettings: { effort: "xhigh", fast: true },
            },
          },
          {
            kind: "transport-ready",
            recordId: "bad-settings",
            payload: {
              text: "still queued",
              persona: { kind: "inherit" },
              runSettings: { effort: 3, fast: "yes" },
            },
          },
        ],
      }),
    );

    const queues = await loadPersistedMessageQueues();
    expect(queues.s1?.map((record) => record.payload)).toEqual([
      {
        text: "fast and deep",
        persona: { kind: "inherit" },
        runSettings: { effort: "xhigh", fast: true },
      },
      { text: "still queued", persona: { kind: "inherit" } },
    ]);
  });

  it("rejects malformed persona intent instead of guessing", async () => {
    mockInvoke.mockResolvedValue(
      JSON.stringify({
        s1: [
          {
            kind: "transport-ready",
            recordId: "bad-persona",
            payload: {
              text: "do not guess",
              persona: { kind: "persona" },
              executionTarget: { harnessId: "goose" },
            },
          },
        ],
      }),
    );

    await expect(loadPersistedMessageQueues()).resolves.toEqual({});
  });

  it("rejects deferred records without supported workspace-first-send state", async () => {
    mockInvoke.mockResolvedValue(
      JSON.stringify({
        s1: [
          {
            kind: "deferred",
            recordId: "unsupported-deferred",
            payload: { text: "do not send" },
            state: { type: "unknown", status: "held" },
          },
        ],
      }),
    );

    await expect(loadPersistedMessageQueues()).resolves.toEqual({});
  });

  it("preserves draft queues with the metadata needed for recovery", async () => {
    mockInvoke.mockResolvedValue(undefined);
    useChatSessionStore.setState({
      sessions: [
        { id: "draft-1", creationState: "pending" } as unknown as ChatSession,
        { id: "draft-2", creationState: "failed" } as unknown as ChatSession,
      ],
    });

    persistMessageQueues(
      {
        "draft-1": [
          {
            kind: "transport-ready",
            recordId: "pending-record",
            payload: admitSystemInheritedQueuedMessage({ text: "pending" }),
          },
        ],
        "draft-2": [
          {
            kind: "transport-ready",
            recordId: "failed-record",
            payload: admitSystemInheritedQueuedMessage({ text: "failed" }),
          },
        ],
      },
      ["draft-1", "draft-2"],
    );

    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalled());
    const saved = JSON.parse(mockInvoke.mock.calls[0][1].serializedUpdates);
    expect(saved["draft-1"][0]).toMatchObject({
      payload: { text: "pending" },
      draftSession: { id: "draft-1", creationState: "pending" },
    });
    expect(saved["draft-2"][0]).toMatchObject({
      payload: { text: "failed" },
      draftSession: { id: "draft-2", creationState: "failed" },
    });
    expect(
      window.localStorage.getItem("distill:chat-message-queues:v1"),
    ).toContain("pending-record");
  });

  it("writes only changed sessions through native read-modify-write persistence", async () => {
    mockInvoke.mockResolvedValue(undefined);
    persistMessageQueues(
      {
        s1: [
          {
            kind: "transport-ready",
            recordId: "queued-image",
            payload: admitSystemInheritedQueuedMessage({
              text: "inspect this",
            }),
          },
        ],
      },
      ["s1"],
    );
    await vi.waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("persist_message_queue_updates", {
        serializedUpdates: JSON.stringify({
          s1: [
            {
              kind: "transport-ready",
              recordId: "queued-image",
              payload: admitSystemInheritedQueuedMessage({
                text: "inspect this",
              }),
            },
          ],
        }),
      }),
    );
  });
});
