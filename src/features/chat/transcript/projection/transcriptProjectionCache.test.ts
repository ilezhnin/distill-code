import { describe, expect, it } from "vitest";
import type {
  Message,
  MessageContent,
  MessageMetadata,
  ToolRequestContent,
} from "@/shared/types/messages";
import { buildMessageRevisions } from "./messageRevisions";
import { createTranscriptProjectionCache } from "./transcriptProjectionCache";
import type {
  TranscriptProjectionSnapshot,
  TranscriptRowDescriptor,
} from "./transcriptItemTypes";

const SESSION_ID = "session-1";
const NOW_BUCKET = "2026-06-04";
const LOCALE_KEY = "en-US";

describe("transcript projection cache", () => {
  it("keeps prefix descriptors and stable row keys across streaming updates", () => {
    const cache = createTranscriptProjectionCache();
    const user = message("user-1", "user", "prompt", utc(2026, 6, 4, 10));
    const assistant = message(
      "assistant-1",
      "assistant",
      "hel",
      utc(2026, 6, 4, 10, 1),
      { completionStatus: "inProgress" },
    );

    const first = update(cache, [user, assistant], "assistant-1");
    const assistantBefore = messageRow(first, "assistant-1");
    const second = update(
      cache,
      [user, { ...assistant, content: [{ type: "text", text: "hello" }] }],
      "assistant-1",
    );
    const assistantAfter = messageRow(second, "assistant-1");

    expect(second.reusedPrefixCount).toBe(2);
    expect(second.rows[0]).toBe(first.rows[0]);
    expect(second.rows[1]).toBe(first.rows[1]);
    expect(assistantAfter).not.toBe(assistantBefore);
    expect(assistantAfter.rowId).toBe(assistantBefore.rowId);
    expect(assistantAfter.reactKey).toBe(assistantBefore.reactKey);
    expect(assistantAfter.renderRevision).not.toBe(
      assistantBefore.renderRevision,
    );
    expect(assistantAfter.heightRevision).not.toBe(
      assistantBefore.heightRevision,
    );
    expect(assistantAfter.anchorPriority).toBe("streaming");
    expect(assistantAfter.rowId).toBe("message:assistant-1");
    expect(assistantAfter.kind).toBe("message");
    expect([...second.changedRowIds]).toEqual(["message:assistant-1"]);
  });

  it("fragments a long response after active streaming is cancelled", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = message(
      "assistant-cancelled",
      "assistant",
      multiParagraphText("cancelled streaming fragment", 3, 20),
      utc(2026, 6, 4, 10),
      { completionStatus: "inProgress" },
    );

    const active = update(cache, [assistant], "assistant-cancelled");
    const activeRow = messageRow(active, "assistant-cancelled");

    const cancelling = update(cache, [assistant], null);
    const cancellingCompletedFragment = rowById(
      cancelling,
      "message:assistant-cancelled:stream-block-0",
    );
    const cancellingTail = rowById(
      cancelling,
      "message:assistant-cancelled:stream-tail",
    );

    expect(active.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-cancelled",
      "message:assistant-cancelled",
    ]);
    expect(activeRow.kind).toBe("message");
    expect(activeRow.anchorPriority).toBe("streaming");
    expect(active.fragmentRowCount).toBe(0);
    expect(active.completedStreamingFragmentRowCount).toBe(0);
    expect(active.streamingTailRowCount).toBe(0);
    expect(active.wholeMessageFallbackRowCount).toBe(1);
    expect(cancelling.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-cancelled",
      "message:assistant-cancelled:stream-block-0",
      "message:assistant-cancelled:stream-block-1",
      "message:assistant-cancelled:stream-tail",
    ]);
    expect(cancellingCompletedFragment.anchorPriority).toBe("stable");
    expect(cancellingCompletedFragment.fragment?.isStreamingTail).toBe(false);
    expect(cancellingTail.anchorPriority).toBe("stable");
    expect(cancellingTail.fragment?.isStreamingTail).toBe(false);
    expect(cancelling.streamingTailRowCount).toBe(0);
    expect(cancelling.completedStreamingFragmentRowCount).toBe(2);
    expect(cancelling.rowByMessageId.get("assistant-cancelled")).toBe(
      "message:assistant-cancelled:stream-block-0",
    );
    expect([...cancelling.changedRowIds]).toEqual([
      "message:assistant-cancelled:stream-block-0",
      "message:assistant-cancelled:stream-block-1",
      "message:assistant-cancelled:stream-tail",
      "message:assistant-cancelled",
    ]);

    const stopped = update(
      cache,
      [
        {
          ...assistant,
          metadata: {
            ...assistant.metadata,
            completionStatus: "stopped",
          },
        },
      ],
      null,
    );

    expect(stopped.rows.map((row) => row.rowId)).toEqual(
      cancelling.rows.map((row) => row.rowId),
    );
    expect(rowById(stopped, "message:assistant-cancelled:stream-tail")).toBe(
      cancellingTail,
    );
    expect([...stopped.changedRowIds]).toEqual([]);
  });

  it("projects reasoning and tools into an ordered agent work row", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-reasoning-tools",
      "assistant",
      [
        { type: "thinking", text: "I should inspect the files first." },
        toolRequest("tool-1"),
        { type: "thinking", text: "Now I should compare the results." },
        toolRequest("tool-2"),
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);

    expect(snapshot.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-reasoning-tools",
      "message:assistant-reasoning-tools:agent-work",
    ]);
    const workRow = rowById(
      snapshot,
      "message:assistant-reasoning-tools:agent-work",
    );
    expect(workRow.kind).toBe("agent-work");
    expect(workRow.agentWork?.thoughtCount).toBe(2);
    expect(workRow.agentWork?.toolCount).toBe(2);
    expect(snapshot.wholeMessageFallbackRowCount).toBe(0);
  });

  it("dedupes adjacent duplicate reasoning-only assistant messages", () => {
    const cache = createTranscriptProjectionCache();
    const firstThought = messageWithContent(
      "assistant-thought-1",
      "assistant",
      [{ type: "thinking", text: "I should inspect the files first." }],
      utc(2026, 6, 4, 10),
    );
    const duplicateThought = messageWithContent(
      "assistant-thought-2",
      "assistant",
      [{ type: "thinking", text: "I should inspect the files first." }],
      utc(2026, 6, 4, 10) + 1,
    );
    const nextThought = messageWithContent(
      "assistant-thought-3",
      "assistant",
      [{ type: "thinking", text: "Now I should compare the results." }],
      utc(2026, 6, 4, 10) + 2,
    );

    const snapshot = update(cache, [
      firstThought,
      duplicateThought,
      nextThought,
    ]);

    expect(snapshot.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-thought-1",
      "message:assistant-thought-1:agent-work",
      "message:assistant-thought-3:agent-work",
    ]);
  });

  it("keeps agent work projected when a completed turn also contains an image", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-work-with-image",
      "assistant",
      [
        { type: "thinking", text: "I should inspect the rendered result." },
        toolRequest("tool-1"),
        { type: "text", text: "The implementation is complete." },
        {
          type: "image",
          data: "c2NyZWVuc2hvdA==",
          mimeType: "image/png",
        },
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);

    expect(snapshot.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-work-with-image",
      "message:assistant-work-with-image:agent-work",
      "message:assistant-work-with-image:answer",
      expect.stringMatching(
        /^message:assistant-work-with-image:companion-image-/,
      ),
    ]);
    expect(
      rowById(snapshot, "message:assistant-work-with-image:agent-work").kind,
    ).toBe("agent-work");
    expect(
      rowById(snapshot, "message:assistant-work-with-image:answer").kind,
    ).toBe("message");
    expect(
      snapshot.rows.find((row) =>
        row.rowId.startsWith(
          "message:assistant-work-with-image:companion-image-",
        ),
      )?.kind,
    ).toBe("message");
  });

  it("preserves work and companion source order", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-interleaved-companion",
      "assistant",
      [
        toolRequest("tool-1"),
        { type: "image", data: "cHJldmlldw==", mimeType: "image/png" },
        toolRequest("tool-2"),
        { type: "text", text: "Here is the final answer." },
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);

    expect(snapshot.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-interleaved-companion",
      "message:assistant-interleaved-companion:agent-work-0",
      expect.stringMatching(
        /^message:assistant-interleaved-companion:companion-image-/,
      ),
      "message:assistant-interleaved-companion:agent-work-1",
      "message:assistant-interleaved-companion:answer",
    ]);
  });

  it("does not merge final-answer text across a companion boundary", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-split-answer",
      "assistant",
      [
        toolRequest("tool-1"),
        { type: "text", text: "The first result is ready." },
        { type: "image", data: "cHJldmlldw==", mimeType: "image/png" },
        { type: "text", text: "Here is the final answer." },
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);
    const workRow = rowById(
      snapshot,
      "message:assistant-split-answer:agent-work",
    );

    expect(snapshot.rows.map((row) => row.kind)).toEqual([
      "date-separator",
      "agent-work",
      "message",
      "message",
    ]);
    expect(workRow.agentWork?.content).toContainEqual({
      type: "text",
      text: "The first result is ready.",
    });
    const answer = snapshot.items.find(
      (item) => item.itemId === "message:assistant-split-answer:answer",
    );
    expect(answer?.kind).toBe("message");
    if (answer?.kind === "message") {
      expect(answer.visibleContent).toEqual([
        { type: "text", text: "Here is the final answer." },
      ]);
    }
  });

  it("preserves speech state across agent-work and final-answer projection", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-voice-work",
      "assistant",
      [
        {
          type: "text",
          text: "First spoken block.",
          speech: { status: "spoken" },
        },
        toolRequest("tool-1"),
        {
          type: "thinking",
          text: "Considering the result.",
        },
        {
          type: "text",
          text: "Final speaking block.",
          speech: { status: "speaking" },
        },
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);
    const work = snapshot.items.find(
      (item) => item.itemId === "message:assistant-voice-work:agent-work",
    );
    const answer = snapshot.items.find(
      (item) => item.itemId === "message:assistant-voice-work:answer",
    );

    expect(work?.kind).toBe("agent-work");
    if (work?.kind === "agent-work") {
      expect(work.content).toContainEqual({
        type: "text",
        text: "First spoken block.",
        speech: { status: "spoken" },
      });
    }
    expect(answer?.kind).toBe("message");
    if (answer?.kind === "message") {
      expect(answer.visibleContent).toEqual([
        {
          type: "text",
          text: "Final speaking block.",
          speech: { status: "speaking" },
        },
      ]);
    }
  });

  it("filters hidden messages and creates date separators for visible groups", () => {
    const cache = createTranscriptProjectionCache();
    const visibleYesterday = message(
      "user-1",
      "user",
      "visible yesterday",
      utc(2026, 6, 3, 12),
    );
    const hiddenToday = message(
      "hidden-1",
      "assistant",
      "hidden",
      utc(2026, 6, 4, 12),
      { userVisible: false },
    );
    const emptyStreaming = {
      ...message("empty-1", "assistant", "", utc(2026, 6, 4, 12, 1), {
        completionStatus: "inProgress",
      }),
      content: [],
    };
    const visibleToday = message(
      "assistant-1",
      "assistant",
      "visible today",
      utc(2026, 6, 4, 12, 2),
    );

    const snapshot = update(cache, [
      visibleYesterday,
      hiddenToday,
      emptyStreaming,
      visibleToday,
    ]);

    expect(snapshot.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-03:before:user-1",
      "message:user-1",
      "date:2026-06-04:before:assistant-1",
      "message:assistant-1",
    ]);
    expect(snapshot.rows[0]?.date?.labelKey).toBe("yesterday");
    expect(snapshot.rows[2]?.date?.labelKey).toBe("today");
    expect(snapshot.rowByMessageId.has("hidden-1")).toBe(false);
    expect(snapshot.rowByMessageId.has("empty-1")).toBe(false);
    expect(snapshot.searchableTextByMessageId.get("assistant-1")).toBe(
      "visible today",
    );
  });

  it.each([
    ["agent identity", { subagentAgentName: "Rivet" }],
    ["task description", { subagentTaskLabel: "Count markdown files" }],
    ["configured task", { subagentTaskIsConfigured: true }],
  ] satisfies Array<
    [string, Partial<ToolRequestContent>]
  >)("invalidates tool rows for provenance-only %s updates", (_label, provenance) => {
    const originalRequest: ToolRequestContent = {
      type: "toolRequest",
      id: "tool-1",
      name: "load",
      arguments: { task_id: "20260807_72" },
      status: "pending",
    };
    const original = messageWithContent(
      "assistant-1",
      "assistant",
      [originalRequest],
      utc(2026, 6, 4, 10),
    );
    const updated = {
      ...original,
      content: [{ ...originalRequest, ...provenance }],
    };

    const before = buildMessageRevisions(original);
    const after = buildMessageRevisions(updated);

    expect(after.renderRevision).not.toBe(before.renderRevision);
    expect(after.heightRevision).not.toBe(before.heightRevision);
  });

  it("preserves row identity when promoting a draft session", () => {
    const cache = createTranscriptProjectionCache();
    const messages = [
      message("user-1", "user", "prompt", utc(2026, 6, 4, 10)),
      messageWithContent(
        "assistant-1",
        "assistant",
        [toolRequest("tool-1", [{ path: "/tmp/report.md", line: 7 }])],
        utc(2026, 6, 4, 10, 1),
      ),
    ];

    const draft = updateSession(cache, "draft-session", messages);
    cache.promoteSession("draft-session", "real-session");
    const promoted = updateSession(cache, "real-session", messages);

    expect(promoted.rows[0]).toBe(draft.rows[0]);
    expect(promoted.rows[1]).toBe(draft.rows[1]);
    expect(promoted.rows[2]).toBe(draft.rows[2]);
    expect(promoted.descriptorChurn).toBe(0);
    expect(promoted.artifactIndex.artifacts[0]?.sessionId).toBe("real-session");
    expect(promoted.artifactIndex.artifacts[0]?.artifactKey).toMatch(
      /^artifact:real-session:assistant-1:tool-1:/,
    );
  });

  it("drops cached descriptors and artifacts on cleanup", () => {
    const cache = createTranscriptProjectionCache();
    const messages = [
      message("user-1", "user", "prompt", utc(2026, 6, 4, 10)),
      messageWithContent(
        "assistant-1",
        "assistant",
        [toolRequest("tool-1", [{ path: "/tmp/report.md", line: 7 }])],
        utc(2026, 6, 4, 10, 1),
      ),
    ];

    const first = update(cache, messages);
    cache.cleanupSession(SESSION_ID);
    const second = update(cache, messages);

    expect(second.rows[0]).not.toBe(first.rows[0]);
    expect(second.rows[1]).not.toBe(first.rows[1]);
    expect(second.rows[2]).not.toBe(first.rows[2]);
    expect(second.descriptorChurn).toBe(0);
    expect(second.changedRowIds.size).toBe(second.rows.length);
    expect(second.artifactIndex.artifacts[0]).not.toBe(
      first.artifactIndex.artifacts[0],
    );
  });

  it("keeps stateful React identity separate from PR 928 anchor revisions", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-1",
      "assistant",
      [
        {
          ...toolRequest("tool-1", [{ path: "/tmp/report.md", line: 7 }]),
          status: "in_progress",
          startedAt: utc(2026, 6, 4, 10),
        },
      ],
      utc(2026, 6, 4, 10),
    );

    const first = update(cache, [assistant]);
    const before = messageRow(first, "assistant-1");
    const second = update(cache, [
      {
        ...assistant,
        content: [
          {
            ...toolRequest("tool-1", [{ path: "/tmp/report.md", line: 7 }]),
            status: "completed",
          },
        ],
      },
    ]);
    const after = messageRow(second, "assistant-1");

    expect(after).not.toBe(before);
    expect(after.rowId).toBe(before.rowId);
    expect(after.reactKey).toBe(before.reactKey);
    expect(after.reactKey).toBe(after.rowId);
    expect(after.reactKey).not.toContain(after.heightRevision);
    expect(after.heightRevision).not.toBe(before.heightRevision);
    expect(after.measurementPolicy).not.toBe(before.measurementPolicy);
  });
});

function update(
  cache: ReturnType<typeof createTranscriptProjectionCache>,
  messages: readonly Message[],
  streamingMessageId: string | null = null,
): TranscriptProjectionSnapshot {
  return updateSession(cache, SESSION_ID, messages, streamingMessageId);
}

function updateSession(
  cache: ReturnType<typeof createTranscriptProjectionCache>,
  sessionId: string,
  messages: readonly Message[],
  streamingMessageId: string | null = null,
): TranscriptProjectionSnapshot {
  return cache.update({
    sessionId,
    sessionEpoch: 1,
    messages,
    streamingMessageId,
    nowBucket: NOW_BUCKET,
    localeKey: LOCALE_KEY,
  });
}

function messageRow(
  snapshot: TranscriptProjectionSnapshot,
  messageId: string,
): TranscriptRowDescriptor {
  const rowId = snapshot.rowByMessageId.get(messageId);
  expect(rowId).toBeDefined();
  const rowIndex = snapshot.rowIndexById.get(rowId ?? "");
  expect(rowIndex).toBeDefined();
  const row = snapshot.rows[rowIndex ?? -1];
  expect(row).toBeDefined();
  return row;
}

function rowById(
  snapshot: TranscriptProjectionSnapshot,
  rowId: string,
): TranscriptRowDescriptor {
  const rowIndex = snapshot.rowIndexById.get(rowId);
  expect(rowIndex).toBeDefined();
  const row = snapshot.rows[rowIndex ?? -1];
  expect(row).toBeDefined();
  return row;
}

function message(
  id: string,
  role: Message["role"],
  text: string,
  created: number,
  metadata: MessageMetadata = {},
): Message {
  return messageWithContent(
    id,
    role,
    text ? [{ type: "text", text }] : [],
    created,
    metadata,
  );
}

function messageWithContent(
  id: string,
  role: Message["role"],
  content: MessageContent[],
  created: number,
  metadata: MessageMetadata = {},
): Message {
  return {
    id,
    role,
    created,
    content,
    metadata: {
      userVisible: true,
      ...metadata,
    },
  };
}

function toolRequest(
  id: string,
  locations: ToolRequestContent["locations"] = [],
): ToolRequestContent {
  return {
    type: "toolRequest",
    id,
    name: "write_file",
    toolName: "write_file",
    arguments: { path: locations[0]?.path ?? "/tmp/report.md" },
    status: "completed",
    toolKind: "edit",
    locations,
  };
}

function multiParagraphText(
  label: string,
  paragraphCount: number,
  linesPerParagraph: number,
): string {
  return Array.from({ length: paragraphCount }, (_, pIndex) =>
    Array.from(
      { length: linesPerParagraph },
      (_, lIndex) =>
        `${label} p${pIndex} line ${String(lIndex).padStart(3, "0")}`,
    ).join("\n"),
  ).join("\n\n");
}

function utc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): number {
  return Date.UTC(year, month - 1, day, hour, minute);
}
