import { describe, expect, it } from "vitest";

import { looksLikeClaudeExport, parseClaudeExport } from "./parseClaudeExport";

function conversation(overrides: object = {}) {
  return {
    uuid: "c-1",
    name: "A chat",
    created_at: "2026-08-01T10:00:00Z",
    updated_at: "2026-08-01T11:00:00Z",
    chat_messages: [
      {
        uuid: "m1",
        sender: "human",
        text: "Hello",
        created_at: "2026-08-01T10:00:00Z",
      },
      {
        uuid: "m2",
        sender: "assistant",
        text: "",
        content: [{ type: "text", text: "Hi there" }],
        created_at: "2026-08-01T10:00:05Z",
      },
    ],
    ...overrides,
  };
}

describe("parseClaudeExport", () => {
  it("reads a conversation in order", () => {
    const { transcripts, skipped } = parseClaudeExport({
      conversations: [conversation()],
    });

    expect(skipped).toBe(0);
    expect(transcripts[0].messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Hello"],
      ["assistant", "Hi there"],
    ]);
  });

  it("reads the older shape, where the body was a plain string", () => {
    const older = conversation({
      chat_messages: [{ uuid: "m", sender: "assistant", text: "Older reply" }],
    });
    expect(
      parseClaudeExport({ conversations: [older] }).transcripts[0].messages[0]
        .text,
    ).toBe("Older reply");
  });

  it("remembers which project a chat belonged to", () => {
    const scoped = conversation({ project: { name: "Farstead" } });
    expect(
      parseClaudeExport({ conversations: [scoped] }).transcripts[0].projectName,
    ).toBe("Farstead");
  });

  it("keeps a project's instructions and documents", () => {
    const { projects } = parseClaudeExport({
      projects: [
        {
          uuid: "p-1",
          name: "Farstead",
          description: "The game",
          prompt_template: "Always answer in Russian.",
          created_at: "2026-07-01T00:00:00Z",
          docs: [
            { uuid: "d1", filename: "design.md", content: "# Design" },
            { uuid: "d2", filename: "", content: "no name" },
          ],
        },
      ],
    });

    expect(projects).toHaveLength(1);
    expect(projects[0].instructions).toBe("Always answer in Russian.");
    expect(projects[0].documents).toEqual([
      { name: "design.md", text: "# Design" },
    ]);
  });

  it("counts what it cannot read", () => {
    const result = parseClaudeExport({
      conversations: [conversation(), { name: "no uuid" }, "nope"],
    });
    expect(result.transcripts).toHaveLength(1);
    expect(result.skipped).toBe(2);
  });

  it("has no opinion on junk", () => {
    expect(parseClaudeExport({}).transcripts).toEqual([]);
    expect(parseClaudeExport({ conversations: null }).projects).toEqual([]);
  });
});

describe("looksLikeClaudeExport", () => {
  it("recognises either of the two files in the zip", () => {
    expect(looksLikeClaudeExport([conversation()])).toBe(true);
    expect(looksLikeClaudeExport([{ uuid: "p", docs: [] }])).toBe(true);
    expect(looksLikeClaudeExport([{ mapping: {} }])).toBe(false);
  });
});
