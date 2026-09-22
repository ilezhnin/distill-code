import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { toast } from "sonner";
import {
  handleSessionNotification,
  clearMessageTracking,
} from "../acpNotificationHandler";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  clearReplayBuffer,
  getReplayBuffer,
} from "@/features/chat/hooks/replayBuffer";
import { getToolItemStatus } from "@/features/chat/lib/toolChainGrouping";
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

  it("ignores orphan chunks and keeps notices out of history", async () => {
    await send({
      sessionUpdate: "compaction_summary_chunk",
      compactionId: "missing",
      content: { type: "text", text: "ignored" },
    });
    await send({
      sessionUpdate: "notice",
      title: "Usage warning",
      severity: "warning",
      description: "Details",
    });
    expect(messages(replay)).toEqual([]);
    expect(toast.warning).toHaveBeenCalledTimes(replay ? 0 : 1);
  });

  it("preserves compaction metadata patch semantics through host replay stamps", async () => {
    const update = {
      sessionUpdate: "compaction_update",
      compactionId: "c1",
      status: "in_progress",
    } as const;
    await send({ ...update, _meta: { vendor: true } });
    await send({
      ...update,
      status: "completed",
      _meta: { distill: { compactionMetaPatch: {} } },
    });
    expect(compaction(replay)?._meta).toEqual({ vendor: true });
    await send({
      ...update,
      status: "completed",
      _meta: { distill: { compactionMetaPatch: { value: null } } },
    });
    expect(compaction(replay)?._meta).toBeNull();
  });

  it("retains streamed terminal output without completing the running tool", async () => {
    await send({
      sessionUpdate: "tool_call",
      toolCallId: "cmd",
      title: "Run check",
      kind: "execute",
    });
    for (const data of ["one\n", "two\n"]) {
      await send({
        sessionUpdate: "tool_call_update",
        toolCallId: "cmd",
        _meta: { terminal_output_delta: { terminal_id: "cmd", data } },
      });
    }
    flushAllBufferedStreamingUpdates();
    const request = messages(replay)[0].content.find(
      (block) => block.type === "toolRequest",
    );
    expect(request?.terminalOutput).toBe("one\ntwo\n");
    expect(getToolItemStatus({ key: "cmd", request })).toBe("in_progress");
    await send({
      sessionUpdate: "tool_call_update",
      toolCallId: "cmd",
      status: "completed",
      _meta: { terminal_exit: { terminal_id: "cmd", exit_code: 0 } },
    });
    expect(
      messages(replay)[0].content.find(
        (block) => block.type === "toolResponse",
      ),
    ).toMatchObject({
      result: "one\ntwo\n",
      isError: false,
      structuredContent: { terminal_id: "cmd", exit_code: 0 },
    });
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
