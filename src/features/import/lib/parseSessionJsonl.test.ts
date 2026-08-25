import { describe, expect, it } from "vitest";

import { detectSessionSource, parseSessionJsonl } from "./parseSessionJsonl";

const CODEX = [
  JSON.stringify({
    type: "session_meta",
    item: {
      session_id: "abc123",
      timestamp: "2026-08-01T10:00:00Z",
      cwd: "/work/repo",
      model: "gpt-5",
    },
    seq: 1,
  }),
  JSON.stringify({
    type: "user_message",
    item: { content: "Fix the build", timestamp: "2026-08-01T10:00:01Z" },
    seq: 2,
  }),
  JSON.stringify({
    type: "tool_call",
    item: { call_id: "t1", tool_name: "shell", arguments: "cargo build" },
    seq: 3,
  }),
  JSON.stringify({
    type: "assistant_message",
    item: { content: "Done.", timestamp: "2026-08-01T10:01:00Z" },
    seq: 4,
  }),
].join("\n");

const CLAUDE_CODE = [
  JSON.stringify({
    type: "user",
    message: { role: "user", content: "Fix the build" },
    timestamp: "2026-08-01T10:00:01Z",
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "On it." },
        { type: "tool_use", name: "Bash", input: {} },
      ],
    },
    timestamp: "2026-08-01T10:00:02Z",
  }),
  JSON.stringify({ type: "summary", summary: "build fix" }),
].join("\n");

describe("parseSessionJsonl — Codex", () => {
  it("reads the conversation and drops the tool traffic", () => {
    const transcript = parseSessionJsonl("codex", CODEX, "rollout-x.jsonl");

    expect(transcript?.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Fix the build"],
      ["assistant", "Done."],
    ]);
    expect(transcript?.sourceId).toBe("abc123");
    expect(transcript?.cwd).toBe("/work/repo");
  });

  it("falls back to the file name when the file names no session", () => {
    const noMeta = CODEX.split("\n").slice(1).join("\n");
    expect(
      parseSessionJsonl("codex", noMeta, "rollout-x.jsonl")?.sourceId,
    ).toBe("rollout-x.jsonl");
  });

  it("survives the half-written last line of a live file", () => {
    const truncated = `${CODEX}\n{"type":"assistant_message","item":{"cont`;
    expect(parseSessionJsonl("codex", truncated, "f")?.messages).toHaveLength(
      2,
    );
  });
});

describe("parseSessionJsonl — Claude Code", () => {
  it("reads text blocks and ignores tool blocks", () => {
    const transcript = parseSessionJsonl(
      "claude-code",
      CLAUDE_CODE,
      "session.jsonl",
    );

    expect(transcript?.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Fix the build"],
      ["assistant", "On it."],
    ]);
  });

  it("titles a session after what was asked", () => {
    expect(
      parseSessionJsonl("claude-code", CLAUDE_CODE, "session.jsonl")?.title,
    ).toBe("Fix the build");
  });
});

describe("parseSessionJsonl — nothing worth importing", () => {
  it("returns nothing for an empty or toolonly file", () => {
    expect(parseSessionJsonl("codex", "", "f")).toBeNull();
    expect(
      parseSessionJsonl(
        "codex",
        JSON.stringify({ type: "tool_call", item: {} }),
        "f",
      ),
    ).toBeNull();
  });
});

describe("detectSessionSource", () => {
  it("tells the two CLIs apart", () => {
    expect(detectSessionSource(CODEX)).toBe("codex");
    expect(detectSessionSource(CLAUDE_CODE)).toBe("claude-code");
  });

  it("guesses at nothing", () => {
    expect(detectSessionSource('{"hello":"world"}')).toBeNull();
    expect(detectSessionSource("")).toBeNull();
  });
});
