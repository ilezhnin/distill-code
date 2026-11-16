import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  handleSessionNotification,
  clearMessageTracking,
} from "../acpNotificationHandler";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  clearReplayBuffer,
  getReplayBuffer,
} from "@/features/chat/hooks/replayBuffer";
import { extractToolResultText } from "../acpToolCallContent";
import {
  clearBufferedStreamingUpdatesForSession,
  flushAllBufferedStreamingUpdates,
} from "../liveStreamingUpdates";

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock("../acpWorkspaceObservation", () => ({
  observeWorkspaceToolCall: vi.fn(),
  clearWorkspaceToolCallObservations: vi.fn(),
}));
const sessionId = "session-events";
const send = (update: SessionUpdate) =>
  handleSessionNotification({ sessionId, update });
const messages = (replay: boolean) =>
  replay
    ? (getReplayBuffer(sessionId) ?? [])
    : (useChatStore.getState().messagesBySession[sessionId] ?? []);
function compaction(replay: boolean) {
  const block = messages(replay)[0]?.content[0];
  return block?.type === "systemNotification" ? block.compaction : undefined;
}
function measure(replay: boolean) {
  const block = messages(replay)[0]?.content[0];
  return block?.type === "systemNotification"
    ? block.compactionMeasure
    : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearMessageTracking();
  clearBufferedStreamingUpdatesForSession(sessionId);
  clearReplayBuffer(sessionId);
  useChatStore.setState({
    messagesBySession: {},
    sessionStateById: {},
    loadingSessionIds: new Set(),
    activeSessionId: null,
  });
});

describe.each([false, true])("ACP events, replay=%s", (replay) => {
  beforeEach(() =>
    useChatStore.setState({
      loadingSessionIds: new Set(replay ? [sessionId] : []),
    }),
  );

  it("upserts compaction in place, retains chunks on completion and honors explicit clearing", async () => {
    useChatStore.getState().setChatState(sessionId, "streaming");
    const update = {
      sessionUpdate: "compaction_update",
      compactionId: "c1",
      status: "in_progress",
    } as const;
    await send(update);
    const created = messages(replay)[0].created;
    await send({
      sessionUpdate: "compaction_summary_chunk",
      compactionId: "c1",
      content: { type: "text", text: "first " },
    });
    await send({
      sessionUpdate: "compaction_summary_chunk",
      compactionId: "c1",
      content: { type: "text", text: "second" },
    });
    await send({ ...update, status: "completed" });
    expect(compaction(replay)?.summary).toEqual([
      { type: "text", text: "first second" },
    ]);
    await send({
      sessionUpdate: "compaction_summary_chunk",
      compactionId: "c1",
      content: { type: "text", text: "late" },
    });
    expect(compaction(replay)?.summary).toEqual([
      { type: "text", text: "first second" },
    ]);
    await send({ ...update, status: "completed", summary: [] });
    expect(compaction(replay)?.summary).toEqual([]);
    await send({
      ...update,
      status: "failed",
      error: "failed",
      _meta: { diagnostic: true },
    });
    await send({
      ...update,
      status: "cancelled",
      summary: null,
      error: null,
      _meta: null,
    });
    expect(compaction(replay)).toMatchObject({
      status: "cancelled",
      summary: null,
      error: null,
      _meta: null,
    });
    expect(messages(replay)).toHaveLength(1);
    expect(messages(replay)[0].created).toBe(created);
    expect(useChatStore.getState().sessionStateById[sessionId]?.chatState).toBe(
      "streaming",
    );
  });

  it("measures a compaction by the context the host wrote on its updates", async () => {
    // The host's stamp: when the update arrived, the context window as the
    // bridge last counted it, and the bridge's own `_meta` patch.
    const stamp = (
      created: string,
      used: number,
      bridgeMeta?: Record<string, unknown>,
    ) => ({
      ...bridgeMeta,
      distill: {
        created,
        compactionMetaPatch: bridgeMeta ? { value: bridgeMeta } : {},
        contextUsage: { used, size: 258_400 },
      },
    });
    const update = {
      sessionUpdate: "compaction_update",
      compactionId: "c2",
    } as const;
    await send({
      ...update,
      status: "in_progress",
      _meta: stamp("2026-11-14T18:00:00.000Z", 244_380),
    });
    expect(measure(replay)).toEqual({
      usedBefore: 244_380,
      size: 258_400,
      startedAt: Date.UTC(2026, 10, 14, 18, 0, 0),
    });
    await send({
      ...update,
      status: "completed",
      _meta: stamp("2026-11-14T18:00:41.000Z", 14_494),
    });
    // A bridge may end a compaction twice, the second time with its facts.
    await send({
      ...update,
      status: "completed",
      _meta: stamp("2026-11-14T18:00:42.000Z", 14_494, { facts: 1 }),
    });
    expect(measure(replay)).toEqual({
      usedBefore: 244_380,
      usedAfter: 14_494,
      size: 258_400,
      startedAt: Date.UTC(2026, 10, 14, 18, 0, 0),
      endedAt: Date.UTC(2026, 10, 14, 18, 0, 41),
    });
    // The host's stamp is not the compaction's own metadata.
    expect(compaction(replay)?._meta).toEqual({ facts: 1 });
  });
});

it("batches a burst of terminal deltas and flushes the last lines before completion", async () => {
  await send({
    sessionUpdate: "tool_call",
    toolCallId: "cmd",
    title: "Run check",
    kind: "execute",
  });
  let writes = 0;
  const unsubscribe = useChatStore.subscribe(() => {
    writes += 1;
  });
  try {
    for (let i = 0; i < 1000; i++) {
      await send({
        sessionUpdate: "tool_call_update",
        toolCallId: "cmd",
        _meta: {
          terminal_output_delta: { terminal_id: "cmd", data: "line\n" },
        },
      });
    }
    expect(writes).toBe(0);
    flushAllBufferedStreamingUpdates();
    expect(writes).toBe(1);
    await send({
      sessionUpdate: "tool_call_update",
      toolCallId: "cmd",
      _meta: { terminal_output_delta: { terminal_id: "cmd", data: "last\n" } },
    });
    expect(writes).toBe(1);
    await send({
      sessionUpdate: "tool_call_update",
      toolCallId: "cmd",
      status: "completed",
    });
    expect(
      messages(false)[0].content.find((block) => block.type === "toolResponse")
        ?.result,
    ).toBe(`${"line\n".repeat(1000)}last\n`);
  } finally {
    unsubscribe();
  }
});

it("keeps every text block of a tool result", () => {
  expect(
    extractToolResultText({
      content: [
        { type: "content", content: { type: "text", text: "a" } },
        { type: "content", content: { type: "text", text: "b" } },
      ],
    }),
  ).toBe("a\nb");
});
