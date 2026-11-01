import { beforeEach, describe, expect, it } from "vitest";
import type {
  Message,
  MessageContent,
  ToolRequestContent,
} from "@/shared/types/messages";
import { digestProjection } from "../testing/reasoningProjectionFixtures";
import {
  buildTranscriptItems,
  forgetTranscriptItemDescriptorSession,
  getReasoningTextCacheStatsForTests,
  invalidateTranscriptItemDescriptorCache,
} from "./buildTranscriptItems";
import type {
  TranscriptItemDescriptor,
  TranscriptSubagentLinkage,
} from "./transcriptItemTypes";
import { createTranscriptProjectionCache } from "./transcriptProjectionCache";

const SESSION_ID = "session-projection-caches";
const NOW_BUCKET = "2026-06-04";
const LOCALE_KEY = "en-US";
const STREAMING_MESSAGE_ID = "assistant-streaming";

function project(
  messages: readonly Message[],
  streamingMessageId: string | null = null,
  sessionId = SESSION_ID,
): readonly TranscriptItemDescriptor[] {
  return buildTranscriptItems({
    sessionId,
    messages,
    streamingMessageId,
    nowBucket: NOW_BUCKET,
    localeKey: LOCALE_KEY,
    calendarRevisionToken: "0:",
  });
}

function assistant(
  id: string,
  content: MessageContent[],
  created: number,
  completionStatus: "inProgress" | "completed" = "completed",
): Message {
  return {
    id,
    role: "assistant",
    created,
    content,
    metadata: { userVisible: true, completionStatus },
  };
}

function toolCall(id: string, toolName: string): ToolRequestContent {
  return {
    type: "toolRequest",
    id,
    name: toolName,
    toolName,
    arguments: {},
    status: "completed",
  };
}

/** A thought that reads like one: distinct lines, so nothing collapses. */
function thoughtOfLength(length: number): string {
  let text = "**Planning the change**\n\n";
  for (let line = 0; text.length < length; line += 1) {
    text += `Step ${line}: weigh option ${(line * 7) % 13} against ${line}.\n`;
  }
  return text.slice(0, length);
}

function linkageOf(
  items: readonly TranscriptItemDescriptor[],
): TranscriptSubagentLinkage | undefined {
  for (const item of items) {
    if ("subagentLinkage" in item && item.subagentLinkage) {
      return item.subagentLinkage;
    }
  }
  return undefined;
}

describe("buildTranscriptItems caches", () => {
  beforeEach(() => {
    invalidateTranscriptItemDescriptorCache();
  });

  it("keeps the reasoning text caches under their character budget while a long thought streams", () => {
    const settled: Message[] = [
      {
        id: "user-1",
        role: "user",
        created: Date.UTC(2026, 5, 4, 10),
        content: [{ type: "text", text: "Plan the change" }],
        metadata: { userVisible: true },
      },
    ];
    const cache = createTranscriptProjectionCache();
    const projectFrame = (messages: readonly Message[]) =>
      cache.update({
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        messages,
        streamingMessageId: STREAMING_MESSAGE_ID,
        nowBucket: NOW_BUCKET,
        localeKey: LOCALE_KEY,
      });

    // Every frame is a new, longer text; forty frames of a thought that grows
    // to 400 KB are several megabytes of keys when only entries are counted.
    for (let frame = 1; frame <= 40; frame += 1) {
      const messages = [
        ...settled,
        assistant(
          STREAMING_MESSAGE_ID,
          [{ type: "thinking", text: thoughtOfLength(frame * 10_000) }],
          Date.UTC(2026, 5, 4, 10, 1),
          "inProgress",
        ),
      ];
      const streamed = projectFrame(messages);
      const stats = getReasoningTextCacheStatsForTests();
      expect(stats.sanitized.chars).toBeLessThanOrEqual(1_000_000);
      expect(stats.canonical.chars).toBeLessThanOrEqual(1_000_000);

      if (frame % 10 === 0) {
        // Only what is cached changes, never what is projected.
        const fresh = createTranscriptProjectionCache().update({
          sessionId: "fresh",
          sessionEpoch: 1,
          messages,
          streamingMessageId: STREAMING_MESSAGE_ID,
          nowBucket: NOW_BUCKET,
          localeKey: LOCALE_KEY,
        });
        expect(digestProjection(streamed)).toEqual(digestProjection(fresh));
      }
    }
  });

  it("still caches short reasoning texts", () => {
    const messages = [
      assistant(
        "assistant-1",
        [
          { type: "thinking", text: thoughtOfLength(2_000) },
          { type: "text", text: "Done." },
        ],
        Date.UTC(2026, 5, 4, 10),
      ),
    ];

    project(messages);

    const stats = getReasoningTextCacheStatsForTests();
    expect(stats.canonical.entries).toBeGreaterThan(0);
    expect(stats.sanitized.entries).toBeGreaterThan(0);
  });

  it("drops a session's delegate linkage when the session is forgotten", () => {
    const messages = [
      assistant(
        "assistant-delegate",
        [
          toolCall("delegate-1", "delegate"),
          {
            type: "toolResponse",
            id: "delegate-1",
            name: "delegate",
            result: "Started background task task-42",
            isError: false,
          },
        ],
        Date.UTC(2026, 5, 4, 10),
      ),
      assistant(
        "assistant-load",
        [toolCall("load-1", "load")],
        Date.UTC(2026, 5, 4, 10, 1),
      ),
    ];

    const first = linkageOf(project(messages));
    expect(first).toBeDefined();
    // Kept across runs while the delegate blocks are the same.
    expect(linkageOf(project([...messages]))).toBe(first);

    forgetTranscriptItemDescriptorSession(SESSION_ID);

    const afterForget = linkageOf(project([...messages]));
    expect(afterForget).not.toBe(first);
    expect(afterForget).toEqual(first);
  });

  it("keeps other sessions' linkage when one session is forgotten", () => {
    const messages = [
      assistant(
        "assistant-delegate",
        [toolCall("delegate-1", "delegate")],
        Date.UTC(2026, 5, 4, 10),
      ),
      assistant(
        "assistant-load",
        [toolCall("load-1", "load")],
        Date.UTC(2026, 5, 4, 10, 1),
      ),
    ];
    const kept = linkageOf(project(messages, null, "other-session"));
    project(messages);

    forgetTranscriptItemDescriptorSession(SESSION_ID);

    expect(linkageOf(project([...messages], null, "other-session"))).toBe(kept);
  });
});

describe("a turn that ended in tool calls", () => {
  const created = Date.UTC(2026, 5, 4, 11);
  const lastWords: MessageContent[] = [
    { type: "thinking", text: "Finding the engine." },
    toolCall("read-1", "read_file"),
    {
      type: "toolResponse",
      id: "read-1",
      name: "read_file",
      result: "ok",
      isError: false,
    },
    { type: "text", text: "Found it. Running the tests next." },
    toolCall("run-1", "shell"),
    {
      type: "toolResponse",
      id: "run-1",
      name: "shell",
      result: "killed",
      isError: false,
    },
  ];

  it("keeps the agent's last words as a partial answer once the turn settles", () => {
    const items = project([assistant("assistant-partial", lastWords, created)]);
    const answer = items.find(
      (item) => item.kind === "message" && item.rowId.endsWith(":answer"),
    );
    expect(answer).toBeDefined();
    expect(answer?.kind === "message" && answer.partialAnswer).toBe(true);
    expect(
      answer?.kind === "message" &&
        answer.visibleContent.map((block) =>
          block.type === "text" ? block.text : block.type,
        ),
    ).toEqual(["Found it. Running the tests next."]);
    // The tools that ran after the words stay after them, and own the footers.
    const work = items.filter((item) => item.kind === "agent-work");
    expect(work).toHaveLength(2);
    expect(items.indexOf(work[1] as TranscriptItemDescriptor)).toBeGreaterThan(
      items.indexOf(answer as TranscriptItemDescriptor),
    );
    expect(work[1]?.kind === "agent-work" && work[1].hostsTurnFooters).toBe(
      false,
    );
    expect(work[1]?.kind === "agent-work" && work[1].hasFinalAnswer).toBe(
      false,
    );
  });

  it("folds the same words into the live steps while the turn still runs", () => {
    const items = project(
      [assistant(STREAMING_MESSAGE_ID, lastWords, created, "inProgress")],
      STREAMING_MESSAGE_ID,
    );
    expect(items.some((item) => item.kind === "message")).toBe(false);
    expect(items.filter((item) => item.kind === "agent-work")).toHaveLength(1);
  });

  it("does not invent an answer for a turn that never said anything", () => {
    const items = project([
      assistant(
        "assistant-silent",
        [
          toolCall("read-1", "read_file"),
          {
            type: "toolResponse",
            id: "read-1",
            name: "read_file",
            result: "ok",
            isError: false,
          },
        ],
        created,
      ),
    ]);
    expect(items.some((item) => item.kind === "message")).toBe(false);
    const [work] = items.filter((item) => item.kind === "agent-work");
    expect(work?.kind === "agent-work" && work.hostsTurnFooters).toBe(true);
  });

  it("marks nothing partial when the turn ends in its answer", () => {
    const items = project([
      assistant(
        "assistant-whole",
        [
          toolCall("read-1", "read_file"),
          {
            type: "toolResponse",
            id: "read-1",
            name: "read_file",
            result: "ok",
            isError: false,
          },
          { type: "text", text: "Done." },
        ],
        created,
      ),
    ]);
    const answer = items.find((item) => item.kind === "message");
    expect(answer?.kind === "message" && answer.partialAnswer).toBeFalsy();
  });
});
