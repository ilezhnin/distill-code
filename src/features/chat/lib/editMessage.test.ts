import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/shared/types/messages";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { useChatStore } from "../stores/chatStore";
import {
  removeTranscriptMessagePart,
  replaceMessageText,
  updateTranscriptMessageText,
} from "./editMessage";

const mockUpdateSessionMessageText = vi.hoisted(() =>
  vi.fn<
    (
      sessionId: string,
      messageId: string,
      role: "user" | "assistant",
      text: string,
    ) => Promise<{ chunks: number; lastMessage: boolean }>
  >(),
);

const mockRemoveSessionMessagePart = vi.hoisted(() =>
  vi.fn<
    (
      sessionId: string,
      messageId: string,
      role: "user" | "assistant",
      part: { kind: string },
    ) => Promise<{
      removed: number;
      lastMessage: boolean;
      snippet: string | null;
    }>
  >(),
);

vi.mock("@/shared/api/acpApi", () => ({
  updateSessionMessageText: mockUpdateSessionMessageText,
  removeSessionMessagePart: mockRemoveSessionMessagePart,
}));

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    role: "user",
    created: 1,
    content: [{ type: "text", text: "hello" }],
    ...overrides,
  };
}

const toolRequest = {
  type: "toolRequest",
  id: "t1",
  name: "read",
  arguments: {},
  status: "completed",
} as const;

describe("editing one step", () => {
  const stepped = () =>
    message({
      role: "assistant",
      content: [
        { type: "text", text: "Mapping " },
        { type: "text", text: "the codebase." },
        toolRequest,
        { type: "thinking", text: "hmm" },
        { type: "text", text: "Reading more." },
        { ...toolRequest, id: "t2" },
        { type: "text", text: "the answer" },
      ],
    });

  it("rewrites one step and leaves the others alone", () => {
    const edited = replaceMessageText(stepped(), "Mapping everything.", {
      kind: "text",
      ordinal: 0,
    });
    expect(edited.content).toEqual([
      { type: "text", text: "Mapping everything." },
      toolRequest,
      { type: "thinking", text: "hmm" },
      { type: "text", text: "Reading more." },
      { ...toolRequest, id: "t2" },
      { type: "text", text: "the answer" },
    ]);
    const rethought = replaceMessageText(stepped(), "a second thought", {
      kind: "reasoning",
      ordinal: 0,
    });
    expect(rethought.content[3]).toEqual({
      type: "thinking",
      text: "a second thought",
    });
    // A step the message does not have changes nothing.
    expect(
      replaceMessageText(stepped(), "nope", { kind: "text", ordinal: 5 }),
    ).toEqual(stepped());
  });
});

describe("replaceMessageText", () => {
  it("keeps what a user message told the agent alone", () => {
    const edited = replaceMessageText(
      message({
        content: [
          {
            type: "text",
            text: "skill instructions",
            annotations: { audience: ["assistant"] },
          },
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
        ],
      }),
      "hello there",
    );
    expect(edited.content).toEqual([
      {
        type: "text",
        text: "skill instructions",
        annotations: { audience: ["assistant"] },
      },
      { type: "text", text: "hello there" },
    ]);
  });
});

describe("updateTranscriptMessageText", () => {
  beforeEach(() => {
    mockUpdateSessionMessageText.mockReset();
    useChatStore.getState().setMessages("s1", [
      message(),
      message({
        id: "r1",
        role: "assistant",
        content: [{ type: "text", text: "the reply" }],
      }),
    ]);
    useChatSessionStore.setState((state) => ({
      ...state,
      sessions: [
        {
          id: "s1",
          title: "Chat",
          subtitle: "the reply",
          createdAt: "2026-09-21T10:00:00.000Z",
          updatedAt: "2026-09-21T10:00:00.000Z",
          messageCount: 2,
          workingDir: "C:\\work",
        } as (typeof state.sessions)[number],
      ],
    }));
  });

  afterEach(() => {
    useChatStore.getState().setMessages("s1", []);
  });

  it("rewrites the message on the host, then on screen", async () => {
    mockUpdateSessionMessageText.mockResolvedValue({
      chunks: 1,
      lastMessage: false,
    });
    const queryClient = new QueryClient();
    queryClient.setQueryData(["session-search-corpus", "s1", "stamp"], []);
    queryClient.setQueryData(["session-search-corpus", "s2", "stamp"], []);

    await expect(
      updateTranscriptMessageText("s1", message(), "  hello there  ", {
        queryClient,
      }),
    ).resolves.toBe(true);

    expect(mockUpdateSessionMessageText).toHaveBeenCalledWith(
      "s1",
      "m1",
      "user",
      "hello there",
      undefined,
    );
    const shown = useChatStore.getState().messagesBySession.s1;
    expect(shown?.[0]?.content).toEqual([
      { type: "text", text: "hello there" },
    ]);
    expect(shown?.[1]?.content).toEqual([{ type: "text", text: "the reply" }]);
    // The list still quotes the reply: the edit was not the chat's last word.
    expect(useChatSessionStore.getState().getSession("s1")?.subtitle).toBe(
      "the reply",
    );
    // The edited chat's search corpus is forgotten; another chat's is kept.
    expect(
      queryClient.getQueryData(["session-search-corpus", "s1", "stamp"]),
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(["session-search-corpus", "s2", "stamp"]),
    ).toEqual([]);
  });

  it("changes nothing on screen when the host refuses", async () => {
    mockUpdateSessionMessageText.mockRejectedValue(
      new Error("Unknown message"),
    );

    await expect(
      updateTranscriptMessageText("s1", message(), "hello there"),
    ).rejects.toThrow("Unknown message");

    expect(useChatStore.getState().messagesBySession.s1?.[0]?.content).toEqual([
      { type: "text", text: "hello" },
    ]);
  });
});

describe("removeTranscriptMessagePart", () => {
  beforeEach(() => {
    mockRemoveSessionMessagePart.mockReset();
    useChatStore.getState().setMessages("s1", [
      message(),
      message({
        id: "r1",
        role: "assistant",
        content: [
          { type: "text", text: "a step" },
          toolRequest,
          { type: "text", text: "the reply" },
        ],
      }),
    ]);
    useChatSessionStore.setState((state) => ({
      ...state,
      sessions: [
        {
          id: "s1",
          title: "Chat",
          subtitle: "the reply",
          createdAt: "2026-09-21T10:00:00.000Z",
          updatedAt: "2026-09-21T10:00:00.000Z",
          messageCount: 2,
          workingDir: "C:\\work",
        } as (typeof state.sessions)[number],
      ],
    }));
  });

  afterEach(() => {
    useChatStore.getState().setMessages("s1", []);
  });

  it("takes the step out on the host, then on screen", async () => {
    mockRemoveSessionMessagePart.mockResolvedValue({
      removed: 2,
      lastMessage: false,
      snippet: null,
    });
    const reply = useChatStore.getState().messagesBySession.s1?.[1];
    if (!reply) throw new Error("fixture reply missing");
    const queryClient = new QueryClient();
    queryClient.setQueryData(["session-search-corpus", "s1", "stamp"], []);

    await expect(
      removeTranscriptMessagePart(
        "s1",
        reply,
        { kind: "tool", toolCallId: "t1" },
        { queryClient },
      ),
    ).resolves.toBe(true);

    expect(mockRemoveSessionMessagePart).toHaveBeenCalledWith(
      "s1",
      "r1",
      "assistant",
      { kind: "tool", toolCallId: "t1" },
    );
    expect(useChatStore.getState().messagesBySession.s1?.[1]?.content).toEqual([
      { type: "text", text: "a step" },
      { type: "text", text: "the reply" },
    ]);
    expect(useChatSessionStore.getState().getSession("s1")?.subtitle).toBe(
      "the reply",
    );
    expect(
      queryClient.getQueryData(["session-search-corpus", "s1", "stamp"]),
    ).toBeUndefined();
  });

  it("changes nothing on screen when the host refuses, and never asks about a prompt", async () => {
    mockRemoveSessionMessagePart.mockRejectedValue(new Error("No such step"));
    const reply = useChatStore.getState().messagesBySession.s1?.[1];
    if (!reply) throw new Error("fixture reply missing");

    await expect(
      removeTranscriptMessagePart("s1", reply, { kind: "text", ordinal: 0 }),
    ).rejects.toThrow("No such step");
    expect(
      useChatStore.getState().messagesBySession.s1?.[1]?.content,
    ).toHaveLength(3);

    await expect(
      removeTranscriptMessagePart("s1", message(), {
        kind: "text",
        ordinal: 0,
      }),
    ).resolves.toBe(false);
    expect(mockRemoveSessionMessagePart).toHaveBeenCalledTimes(1);
  });
});
