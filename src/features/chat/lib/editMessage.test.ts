import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/shared/types/messages";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { useChatStore } from "../stores/chatStore";
import {
  editableTextIndexes,
  getEditableText,
  isEditableMessage,
  removeMessagePart,
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
const image = { type: "image", data: "aGk=", mimeType: "image/png" } as const;

describe("editableTextIndexes", () => {
  it("names the answer of a reply that did work, not the text between steps", () => {
    const reply = message({
      role: "assistant",
      content: [
        { type: "text", text: "Mapping the codebase now." },
        toolRequest,
        { type: "text", text: "Reading one more file." },
        { ...toolRequest, id: "t2" },
        { type: "text", text: "part one" },
        { type: "text", text: "part two " },
        { type: "thinking", text: "a summary after the answer" },
        image,
      ],
    });
    expect(editableTextIndexes(reply)).toEqual([4, 5]);
    expect(getEditableText(reply)).toBe("part one\n\npart two");
    expect(isEditableMessage(reply)).toBe(true);
  });

  it("finds nothing to edit in a reply that ended on a step", () => {
    const reply = message({
      role: "assistant",
      content: [{ type: "text", text: "Looking." }, toolRequest],
    });
    expect(editableTextIndexes(reply)).toEqual([]);
    expect(isEditableMessage(reply)).toBe(false);
  });

  it("stops the answer at a companion block between two texts", () => {
    const reply = message({
      role: "assistant",
      content: [
        toolRequest,
        { type: "text", text: "before the image" },
        image,
        { type: "text", text: "after the image" },
      ],
    });
    expect(editableTextIndexes(reply)).toEqual([3]);
  });

  it("takes every text block of a reply that did no work", () => {
    const reply = message({
      role: "assistant",
      content: [
        { type: "text", text: "one" },
        image,
        { type: "text", text: "two" },
      ],
    });
    expect(editableTextIndexes(reply)).toEqual([0, 2]);
    expect(getEditableText(reply)).toBe("one\n\ntwo");
  });

  it("skips what a user message told the agent alone", () => {
    const prompt = message({
      content: [
        {
          type: "text",
          text: "skill instructions",
          annotations: { audience: ["assistant"] },
        },
        { type: "text", text: "hello" },
        image,
      ],
    });
    expect(editableTextIndexes(prompt)).toEqual([1]);
    expect(getEditableText(prompt)).toBe("hello");
  });
});

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

  it("names a step's own blocks and text", () => {
    expect(
      editableTextIndexes(stepped(), { kind: "text", ordinal: 0 }),
    ).toEqual([0, 1]);
    expect(getEditableText(stepped(), { kind: "text", ordinal: 0 })).toBe(
      "Mapping\n\nthe codebase.",
    );
    expect(
      editableTextIndexes(stepped(), { kind: "reasoning", ordinal: 0 }),
    ).toEqual([3]);
    expect(getEditableText(stepped(), { kind: "reasoning", ordinal: 0 })).toBe(
      "hmm",
    );
    expect(
      editableTextIndexes(stepped(), { kind: "text", ordinal: 1 }),
    ).toEqual([4]);
    // The answer is the last text run; a tool call has no text to edit.
    expect(
      editableTextIndexes(stepped(), { kind: "text", ordinal: 2 }),
    ).toEqual([6]);
    expect(
      editableTextIndexes(stepped(), { kind: "tool", toolCallId: "t1" }),
    ).toEqual([]);
    expect(
      isEditableMessage(stepped(), { kind: "tool", toolCallId: "t1" }),
    ).toBe(false);
    expect(
      editableTextIndexes(stepped(), { kind: "text", ordinal: 3 }),
    ).toEqual([]);
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

  it("removes a step with everything it was made of", () => {
    const withoutTool = removeMessagePart(stepped(), {
      kind: "tool",
      toolCallId: "t1",
    });
    expect(withoutTool.content).toEqual([
      { type: "text", text: "Mapping " },
      { type: "text", text: "the codebase." },
      { type: "thinking", text: "hmm" },
      { type: "text", text: "Reading more." },
      { ...toolRequest, id: "t2" },
      { type: "text", text: "the answer" },
    ]);
    const withoutFirstText = removeMessagePart(stepped(), {
      kind: "text",
      ordinal: 0,
    });
    expect(withoutFirstText.content[0]).toEqual(toolRequest);
    expect(withoutFirstText.content).toHaveLength(5);
    expect(
      removeMessagePart(stepped(), { kind: "tool", toolCallId: "t9" }),
    ).toEqual(stepped());
  });
});

describe("replaceMessageText", () => {
  it("puts the whole text on the answer and leaves the steps alone", () => {
    const edited = replaceMessageText(
      message({
        role: "assistant",
        content: [
          { type: "thinking", text: "hmm" },
          { type: "text", text: "part one, ", annotations: { priority: 1 } },
          toolRequest,
          { type: "text", text: "part two" },
          { type: "text", text: "part three" },
          image,
        ],
      }),
      "the whole reply",
    );
    expect(edited.content).toEqual([
      { type: "thinking", text: "hmm" },
      { type: "text", text: "part one, ", annotations: { priority: 1 } },
      toolRequest,
      { type: "text", text: "the whole reply" },
      image,
    ]);
  });

  it("puts the whole text on the first block of a reply that did no work", () => {
    const edited = replaceMessageText(
      message({
        role: "assistant",
        content: [
          { type: "text", text: "one", annotations: { priority: 1 } },
          { type: "text", text: "two" },
          image,
        ],
      }),
      "the whole reply",
    );
    expect(edited.content).toEqual([
      { type: "text", text: "the whole reply", annotations: { priority: 1 } },
      image,
    ]);
  });

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

  it("adds a text block to a message that had none", () => {
    const edited = replaceMessageText(
      message({ content: [image] }),
      "now with words",
    );
    expect(edited.content).toEqual([
      image,
      { type: "text", text: "now with words" },
    ]);
  });

  it("returns a new message and leaves the given one alone", () => {
    const original = message();
    const edited = replaceMessageText(original, "changed");
    expect(edited).not.toBe(original);
    expect(original.content).toEqual([{ type: "text", text: "hello" }]);
  });
});

describe("isEditableMessage", () => {
  it("admits the two sides of the conversation when they have text", () => {
    expect(isEditableMessage(message())).toBe(true);
    expect(isEditableMessage(message({ role: "assistant" }))).toBe(true);
  });

  it("refuses system notices and messages without text", () => {
    expect(
      isEditableMessage(
        message({
          role: "system",
          content: [
            { type: "systemNotification", notificationType: "info", text: "x" },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      isEditableMessage(
        message({
          content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
        }),
      ),
    ).toBe(false);
    expect(
      isEditableMessage(message({ content: [{ type: "text", text: "  " }] })),
    ).toBe(false);
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

  it("quotes the edit in the chat list when it was the last word", async () => {
    mockUpdateSessionMessageText.mockResolvedValue({
      chunks: 2,
      lastMessage: true,
    });
    const reply = useChatStore.getState().messagesBySession.s1?.[1];
    if (!reply) throw new Error("fixture reply missing");

    await expect(
      updateTranscriptMessageText("s1", reply, "a better reply"),
    ).resolves.toBe(true);

    expect(mockUpdateSessionMessageText).toHaveBeenCalledWith(
      "s1",
      "r1",
      "assistant",
      "a better reply",
      undefined,
    );
    expect(useChatSessionStore.getState().getSession("s1")?.subtitle).toBe(
      "a better reply",
    );
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

  it("never asks the host about an empty text or a system notice", async () => {
    await expect(
      updateTranscriptMessageText("s1", message(), "   "),
    ).resolves.toBe(false);
    await expect(
      updateTranscriptMessageText(
        "s1",
        message({
          role: "system",
          content: [
            { type: "systemNotification", notificationType: "info", text: "x" },
          ],
        }),
        "changed",
      ),
    ).resolves.toBe(false);
    expect(mockUpdateSessionMessageText).not.toHaveBeenCalled();
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

  it("moves the list snippet when the step was the chat's last word", async () => {
    mockRemoveSessionMessagePart.mockResolvedValue({
      removed: 1,
      lastMessage: true,
      snippet: "a step",
    });
    const reply = useChatStore.getState().messagesBySession.s1?.[1];
    if (!reply) throw new Error("fixture reply missing");

    await removeTranscriptMessagePart("s1", reply, {
      kind: "text",
      ordinal: 1,
    });

    expect(useChatSessionStore.getState().getSession("s1")?.subtitle).toBe(
      "a step",
    );
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
