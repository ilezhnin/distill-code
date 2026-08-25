import { describe, expect, it } from "vitest";

import {
  looksLikeChatgptExport,
  parseChatgptExport,
} from "./parseChatgptExport";

function node(
  id: string,
  parent: string | null,
  message: unknown,
): [string, unknown] {
  return [id, { id, parent, children: [], message }];
}

function turn(role: string, text: string, extra: object = {}) {
  return {
    author: { role },
    content: { content_type: "text", parts: [text] },
    create_time: 1_700_000_000,
    ...extra,
  };
}

function conversation(overrides: object = {}) {
  return {
    conversation_id: "c-1",
    title: "A chat",
    create_time: 1_700_000_000,
    update_time: 1_700_000_100,
    current_node: "n3",
    mapping: Object.fromEntries([
      node("root", null, null),
      node(
        "n1",
        "root",
        turn("system", "hidden setup", {
          metadata: { is_visually_hidden_from_conversation: true },
        }),
      ),
      node("n2", "n1", turn("user", "Hello")),
      node(
        "n3",
        "n2",
        turn("assistant", "Hi there", {
          metadata: { model_slug: "gpt-5" },
        }),
      ),
    ]),
    ...overrides,
  };
}

describe("parseChatgptExport", () => {
  it("reads a conversation in order", () => {
    const { transcripts, skipped } = parseChatgptExport([conversation()]);

    expect(skipped).toBe(0);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Hello"],
      ["assistant", "Hi there"],
    ]);
    expect(transcripts[0].messages[1].model).toBe("gpt-5");
  });

  it("follows the branch that was on screen, not the whole tree", () => {
    // Every edit forks a branch; importing the mapping in key order would
    // interleave abandoned answers into the transcript.
    const forked = conversation({
      current_node: "kept",
      mapping: Object.fromEntries([
        node("root", null, null),
        node("q", "root", turn("user", "Question")),
        node("dropped", "q", turn("assistant", "A discarded answer")),
        node("kept", "q", turn("assistant", "The answer kept")),
      ]),
    });

    const [transcript] = parseChatgptExport([forked]).transcripts;
    const text = transcript.messages.map((m) => m.text).join(" ");
    expect(text).toContain("The answer kept");
    expect(text).not.toContain("A discarded answer");
  });

  it("leaves out the scaffolding the operator never saw", () => {
    const [transcript] = parseChatgptExport([conversation()]).transcripts;
    expect(transcript.messages.some((m) => m.role === "system")).toBe(false);
  });

  it("reads an older export with no current_node", () => {
    const older = conversation({ current_node: undefined });
    const [transcript] = parseChatgptExport([older]).transcripts;
    expect(transcript.messages.map((m) => m.text)).toEqual([
      "Hello",
      "Hi there",
    ]);
  });

  it("survives a cycle in the parent chain", () => {
    const looped = conversation({
      current_node: "a",
      mapping: Object.fromEntries([
        node("a", "b", turn("user", "One")),
        node("b", "a", turn("assistant", "Two")),
      ]),
    });
    expect(parseChatgptExport([looped]).transcripts[0].messages).toHaveLength(
      2,
    );
  });

  it("counts what it cannot read instead of failing the import", () => {
    const result = parseChatgptExport([
      conversation(),
      { title: "no mapping" },
      "not an object",
      conversation({ conversation_id: "empty", mapping: {} }),
    ]);

    expect(result.transcripts).toHaveLength(1);
    expect(result.skipped).toBe(3);
  });

  it("names an untitled conversation after what was asked", () => {
    const [transcript] = parseChatgptExport([
      conversation({ title: null }),
    ]).transcripts;
    expect(transcript.title).toBe("Hello");
  });

  it("reads seconds as seconds", () => {
    const [transcript] = parseChatgptExport([conversation()]).transcripts;
    expect(transcript.createdAt).toBe(1_700_000_000_000);
  });

  it("has no opinion on junk", () => {
    expect(parseChatgptExport(null).transcripts).toEqual([]);
    expect(parseChatgptExport({}).transcripts).toEqual([]);
  });
});

describe("looksLikeChatgptExport", () => {
  it("recognises the export by its branch tree", () => {
    expect(looksLikeChatgptExport([conversation()])).toBe(true);
    expect(looksLikeChatgptExport([{ uuid: "x", chat_messages: [] }])).toBe(
      false,
    );
  });
});
