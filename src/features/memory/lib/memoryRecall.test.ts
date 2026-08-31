import { describe, expect, it } from "vitest";

import type { Message } from "@/shared/types/messages";

import type { ArchivedMemoryEntry, MemoryEntry } from "./memoryEntry";
import type { MemorySearchHit } from "./memorySearch";
import {
  DEFAULT_RECALL_LIMIT,
  detectRecallFenceCandidates,
  formatRecallAnswer,
  isRecallAnswerText,
  MAX_RECALL_LIMIT,
  MEMORY_RECALL_PROMPT,
  parseRecallFence,
  recallBudgetSpent,
  RECALL_FENCE_TAG,
  RECALL_LIMIT_REACHED_TEXT,
  recallReachable,
} from "./memoryRecall";

function fence(body: string): string {
  return ["Let me check.", "```distill-recall", body, "```"].join("\n");
}

function entry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    text: "A fact",
    scope: "global",
    projectId: null,
    createdAt: Date.UTC(2026, 0, 2),
    ...overrides,
  };
}

function archivedEntry(
  overrides: Partial<ArchivedMemoryEntry> & { id: string },
): ArchivedMemoryEntry {
  return {
    ...entry(overrides),
    archivedAt: Date.UTC(2026, 5, 1),
    archiveReason: "capacity",
    ...overrides,
  };
}

function hit(
  overrides: Partial<MemorySearchHit> & { entry: MemoryEntry },
): MemorySearchHit {
  return { matched: ["fact"], phrase: false, ...overrides };
}

function assistant(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [{ type: "text", text }],
    metadata: { completionStatus: "completed" },
  };
}

function user(id: string, text: string): Message {
  return { id, role: "user", created: 1, content: [{ type: "text", text }] };
}

describe("parseRecallFence", () => {
  it("reads a question with its scope and limit", () => {
    expect(
      parseRecallFence(
        fence('{"query":"release branch","scope":"project","limit":3}'),
      ),
    ).toEqual({ query: "release branch", scope: "project", limit: 3 });
  });

  it("defaults to the whole reach and a short answer", () => {
    expect(parseRecallFence(fence('{"query":"deploy"}'))).toEqual({
      query: "deploy",
      scope: "all",
      limit: DEFAULT_RECALL_LIMIT,
    });
  });

  it("takes a bare string as the question", () => {
    expect(parseRecallFence(fence('"who reviews rust"'))?.query).toBe(
      "who reviews rust",
    );
  });

  it("caps an eager limit and ignores a nonsense one", () => {
    expect(parseRecallFence(fence('{"query":"x","limit":400}'))?.limit).toBe(
      MAX_RECALL_LIMIT,
    );
    expect(parseRecallFence(fence('{"query":"x","limit":0}'))?.limit).toBe(
      DEFAULT_RECALL_LIMIT,
    );
    expect(parseRecallFence(fence('{"query":"x","limit":"5"}'))?.limit).toBe(
      DEFAULT_RECALL_LIMIT,
    );
  });

  it("falls back to the full reach when the scope is not one of ours", () => {
    expect(
      parseRecallFence(fence('{"query":"x","scope":"world"}'))?.scope,
    ).toBe("all");
  });

  it("refuses a fence that asks nothing", () => {
    expect(parseRecallFence(fence("not json at all"))).toBeNull();
    expect(parseRecallFence(fence("{}"))).toBeNull();
    expect(parseRecallFence(fence('{"query":"   "}'))).toBeNull();
    expect(parseRecallFence(fence("[1,2,3]"))).toBeNull();
    expect(parseRecallFence("no fence here")).toBeNull();
  });

  it("answers the first block and ignores the rest", () => {
    // Each answer is a message that wakes the model; four questions in one
    // reply would wake it four times.
    const text = [fence('{"query":"first"}'), fence('{"query":"second"}')].join(
      "\n",
    );
    expect(parseRecallFence(text)?.query).toBe("first");
  });

  it("skips an unreadable block to reach a readable one", () => {
    const text = [fence("garbage"), fence('{"query":"second"}')].join("\n");
    expect(parseRecallFence(text)?.query).toBe("second");
  });
});

describe("recallReachable", () => {
  const entries = [
    entry({ id: "g", text: "Global fact" }),
    entry({ id: "mine", text: "Mine", scope: "project", projectId: "p-1" }),
    entry({ id: "theirs", text: "Theirs", scope: "project", projectId: "p-2" }),
  ];

  it("never reaches into another project", () => {
    // LAWS/MEMORY.md, Reading back: crossing projects is the operator's search.
    expect(recallReachable(entries, "p-1", "all").map((e) => e.id)).toEqual([
      "g",
      "mine",
    ]);
  });

  it("honours the asked-for scope", () => {
    expect(recallReachable(entries, "p-1", "global").map((e) => e.id)).toEqual([
      "g",
    ]);
    expect(recallReachable(entries, "p-1", "project").map((e) => e.id)).toEqual(
      ["mine"],
    );
  });

  it("gates the archive the same way", () => {
    const archive = [
      archivedEntry({ id: "a-mine", scope: "project", projectId: "p-1" }),
      archivedEntry({ id: "a-theirs", scope: "project", projectId: "p-2" }),
    ];
    expect(recallReachable(archive, "p-1", "all").map((e) => e.id)).toEqual([
      "a-mine",
    ]);
  });

  it("gives a session with no project only the global list", () => {
    expect(recallReachable(entries, null, "all").map((e) => e.id)).toEqual([
      "g",
    ]);
  });
});

describe("formatRecallAnswer", () => {
  const projectNameOf = (id: string | null) => (id === "p-1" ? "Berd" : "?");

  it("names the scope, the dates and the archive", () => {
    const answer = formatRecallAnswer(
      [
        hit({
          entry: entry({
            id: "g",
            text: "Ivan reviews Rust himself",
            reinforcedAt: Date.UTC(2026, 2, 4),
          }),
        }),
        hit({
          entry: entry({
            id: "p",
            text: "The release branch is release/2026.9",
            scope: "project",
            projectId: "p-1",
          }),
          archived: true,
        }),
      ],
      projectNameOf,
      "release branch",
    );

    expect(answer.split("\n")).toEqual([
      '<memory-recall query="release branch">',
      "- Ivan reviews Rust himself (global; created 2026-01-02; confirmed 2026-03-04)",
      "- The release branch is release/2026.9 (project Berd; created 2026-01-02; archived)",
      "No more matches.",
      "</memory-recall>",
      "Do not repeat this recall for the same question.",
    ]);
  });

  it("says so when the store holds nothing about it", () => {
    const answer = formatRecallAnswer([], projectNameOf, "kubernetes");
    expect(answer).toContain("Nothing found.");
    expect(answer).toContain(
      "Do not repeat this recall for the same question.",
    );
  });

  it("keeps a quoted question from breaking the header", () => {
    const answer = formatRecallAnswer(
      [],
      projectNameOf,
      'the "release"\n  branch',
    );
    expect(answer.split("\n")[0]).toBe(
      "<memory-recall query=\"the 'release' branch\">",
    );
  });
});

describe("the recall loop guard", () => {
  it("recognises both kinds of answer this feature delivers", () => {
    expect(isRecallAnswerText('<memory-recall query="x">\n')).toBe(true);
    expect(isRecallAnswerText(RECALL_LIMIT_REACHED_TEXT)).toBe(true);
    expect(isRecallAnswerText("Please recall the branch")).toBe(false);
  });

  it("is spent once the window holds three answers", () => {
    const answer =
      '<memory-recall query="x">\nNothing found.\n</memory-recall>';
    expect(recallBudgetSpent([answer, "work", answer, "work"])).toBe(false);
    expect(recallBudgetSpent([answer, answer, "work", answer])).toBe(true);
  });
});

describe("detectRecallFenceCandidates", () => {
  it("finds an unanswered question and carries the session's tail", () => {
    const candidates = detectRecallFenceCandidates({
      messagesBySession: {
        "s-1": [
          user("u-1", "What did we decide?"),
          assistant("m-1", fence('{"query":"release branch"}')),
        ],
      },
      isAnswered: () => false,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sessionId: "s-1",
      messageId: "m-1",
      request: { query: "release branch" },
    });
    expect(candidates[0].recentTexts).toHaveLength(2);
  });

  it("leaves an answered question alone", () => {
    expect(
      detectRecallFenceCandidates({
        messagesBySession: {
          "s-1": [assistant("m-1", fence('{"query":"x"}'))],
        },
        isAnswered: (id) => id === "m-1",
      }),
    ).toEqual([]);
  });

  it("waits for the turn to settle", () => {
    const streaming: Message = {
      ...assistant("m-1", fence('{"query":"x"}')),
      metadata: { completionStatus: "inProgress" },
    };
    expect(
      detectRecallFenceCandidates({
        messagesBySession: { "s-1": [streaming] },
        isAnswered: () => false,
      }),
    ).toEqual([]);
  });

  it("ignores a question the operator typed", () => {
    // Only the agent's own settled reply asks through this channel.
    expect(
      detectRecallFenceCandidates({
        messagesBySession: {
          "s-1": [user("u-1", fence('{"query":"x"}'))],
        },
        isAnswered: () => false,
      }),
    ).toEqual([]);
  });
});

describe("MEMORY_RECALL_PROMPT", () => {
  it("teaches the fence it will actually be read from", () => {
    expect(MEMORY_RECALL_PROMPT).toContain(`\`\`\`${RECALL_FENCE_TAG}`);
    const taught = MEMORY_RECALL_PROMPT.match(
      /```distill-recall\s*([\s\S]*?)```/,
    );
    expect(parseRecallFence(fence(taught?.[1] ?? ""))).toEqual({
      query: "release branch",
      scope: "project",
      limit: DEFAULT_RECALL_LIMIT,
    });
  });
});
