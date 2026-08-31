import { afterEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/shared/types/messages";

import type { StructuredReport } from "./types";
import {
  FAILED_ATTEMPTS_HEADING,
  failedAttemptsOf,
  formatFailedAttempts,
  loadFailedAttemptsBlock,
  parseTaskMemoryDocument,
  readTaskMemory,
  recordTaskMemoryVerdict,
  recordWaveInTaskMemory,
  resetTaskMemoryIoForTests,
  setTaskMemoryIoForTests,
  taskMemoryDocumentPath,
  taskMemoryGoal,
  taskMemoryStepOf,
  withRecordedWave,
  type TaskMemoryDocument,
} from "./taskMemory";

const CONDUCTOR_ID = "conductor-1";
const ROOT = "plan-1";

function report(overrides: Partial<StructuredReport> = {}): StructuredReport {
  return {
    runId: "run-1",
    status: "completed",
    summary: "did the thing",
    decisions: [],
    artifacts: [],
    risks: [],
    needsOperator: false,
    nextSuggestedTask: null,
    ...overrides,
  };
}

/** An in-memory project folder, keyed by document path. */
function useFakeFolder(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  setTaskMemoryIoForTests({
    projectRootFor: () => "/repo",
    read: async (_root, path) => files.get(path) ?? null,
    write: async (_root, path, contents) => {
      files.set(path, contents);
    },
  });
  return files;
}

function stored(files: Map<string, string>): TaskMemoryDocument {
  return JSON.parse(
    files.get(taskMemoryDocumentPath(ROOT)) ?? "{}",
  ) as TaskMemoryDocument;
}

function user(id: string, text: string): Message {
  return {
    id,
    role: "user",
    created: 1,
    content: [{ type: "text", text }],
  };
}

function assistant(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    created: 2,
    content: [{ type: "text", text }],
    metadata: { completionStatus: "completed" },
  };
}

afterEach(() => {
  resetTaskMemoryIoForTests();
  vi.restoreAllMocks();
});

describe("task memory mapping", () => {
  it("maps a structured report into one recorded step", () => {
    const step = taskMemoryStepOf({
      role: "scout",
      label: "find the callers",
      report: report({
        status: "completed",
        decisions: ["kept the old signature"],
        artifacts: [
          { label: "notes", path: "docs/notes.md" },
          { label: "spec" },
        ],
        risks: ["untested on Windows"],
      }),
    });
    expect(step).toEqual({
      role: "scout",
      label: "find the callers",
      status: "completed",
      summary: "did the thing",
      decisions: ["kept the old signature"],
      artifacts: ["notes|docs/notes.md", "spec"],
      risks: ["untested on Windows"],
    });
  });

  it("turns failed and blocked steps into failed attempts and nothing else", () => {
    const steps = [
      taskMemoryStepOf({ role: "scout", report: report() }),
      taskMemoryStepOf({
        role: "brigade",
        report: report({ status: "failed", summary: "patched the parser" }),
      }),
      taskMemoryStepOf({
        role: "qa",
        report: report({
          status: "blocked",
          summary: "ran the suite",
          reason: "the fixtures are missing",
        }),
      }),
      taskMemoryStepOf({
        role: "writer",
        report: report({ status: "cancelled", summary: "stopped early" }),
      }),
    ];
    expect(failedAttemptsOf(2, steps)).toEqual([
      { wave: 2, role: "brigade", what: "patched the parser", why: "" },
      {
        wave: 2,
        role: "qa",
        what: "ran the suite",
        why: "the fixtures are missing",
      },
    ]);
  });

  it("falls back to the risks when a failed report gave no reason", () => {
    const steps = [
      taskMemoryStepOf({
        role: "brigade",
        report: report({
          status: "failed",
          summary: "rewrote the resolver",
          risks: ["the cache still holds the old paths", "no test covers it"],
        }),
      }),
    ];
    expect(failedAttemptsOf(1, steps)[0].why).toBe(
      "the cache still holds the old paths; no test covers it",
    );
  });
});

describe("failed attempts block", () => {
  it("is nothing at all when the request has failed nothing", () => {
    expect(formatFailedAttempts([])).toBeNull();
    // A heading over no lines would tell a first wave that something was
    // tried; there must not be one.
    expect(
      formatFailedAttempts([{ wave: 1, role: "qa", what: "", why: "x" }]),
    ).toBeNull();
  });

  it("names the wave, the role, what was tried and why it lost", () => {
    const block = formatFailedAttempts([
      { wave: 1, role: "brigade", what: "patched the parser", why: "" },
      {
        wave: 1,
        role: "qa",
        what: "ran the suite",
        why: "the fixtures are missing",
      },
    ]);
    expect(block).toBe(
      `${FAILED_ATTEMPTS_HEADING}\n- wave 1 (brigade): patched the parser\n- wave 1 (qa): ran the suite — why it failed: the fixtures are missing`,
    );
  });
});

describe("the stored document", () => {
  it("keeps one file per root request, under the project's own folder", () => {
    expect(taskMemoryDocumentPath("plan-1")).toBe("task-memory/plan-1.json");
    // A message id is not a file name; traversal never reaches the backend.
    expect(taskMemoryDocumentPath("../../etc/passwd")).toBe(
      "task-memory/.._.._etc_passwd.json",
    );
  });

  it("records a wave and derives its failed attempts", async () => {
    const files = useFakeFolder();
    await recordWaveInTaskMemory({
      conductorSessionId: CONDUCTOR_ID,
      rootRequestId: ROOT,
      goal: "make the parser accept trailing commas",
      wave: {
        waveId: "wave-1",
        attempt: 1,
        verdict: "undecided",
        steps: [
          taskMemoryStepOf({
            role: "brigade",
            report: report({
              status: "failed",
              summary: "patched the tokenizer",
              risks: ["the lexer rejects it earlier"],
            }),
          }),
        ],
      },
    });
    const document = stored(files);
    expect(document.version).toBe(1);
    expect(document.rootRequestId).toBe(ROOT);
    expect(document.goal).toBe("make the parser accept trailing commas");
    expect(document.waves).toHaveLength(1);
    expect(document.failedAttempts).toEqual([
      {
        wave: 1,
        role: "brigade",
        what: "patched the tokenizer",
        why: "the lexer rejects it earlier",
      },
    ]);
  });

  it("re-recording the same wave does not double its failures", async () => {
    const files = useFakeFolder();
    const wave = {
      waveId: "wave-1",
      attempt: 1,
      verdict: "undecided" as const,
      steps: [
        taskMemoryStepOf({
          role: "brigade",
          report: report({ status: "failed", summary: "patched it" }),
        }),
      ],
    };
    const args = {
      conductorSessionId: CONDUCTOR_ID,
      rootRequestId: ROOT,
      goal: "a goal",
      wave,
    };
    await recordWaveInTaskMemory(args);
    await recordWaveInTaskMemory(args);
    expect(stored(files).waves).toHaveLength(1);
    expect(stored(files).failedAttempts).toHaveLength(1);
  });

  it("stamps the verdict once the conductor has given one", async () => {
    const files = useFakeFolder();
    await recordWaveInTaskMemory({
      conductorSessionId: CONDUCTOR_ID,
      rootRequestId: ROOT,
      goal: "a goal",
      wave: { waveId: "wave-1", attempt: 1, verdict: "undecided", steps: [] },
    });
    await recordTaskMemoryVerdict({
      conductorSessionId: CONDUCTOR_ID,
      rootRequestId: ROOT,
      waveId: "wave-1",
      verdict: "revise",
    });
    expect(stored(files).waves[0].verdict).toBe("revise");
  });

  it("keeps nothing for a chat that has no project folder", async () => {
    const written: string[] = [];
    setTaskMemoryIoForTests({
      projectRootFor: () => null,
      read: async () => null,
      write: async (_root, path) => {
        written.push(path);
      },
    });
    const result = await recordWaveInTaskMemory({
      conductorSessionId: CONDUCTOR_ID,
      rootRequestId: ROOT,
      goal: "a goal",
      wave: { waveId: "wave-1", attempt: 1, verdict: "undecided", steps: [] },
    });
    expect(result).toBeNull();
    expect(written).toEqual([]);
    expect(
      await loadFailedAttemptsBlock({
        conductorSessionId: CONDUCTOR_ID,
        rootRequestId: ROOT,
        revisionCount: 1,
      }),
    ).toBeNull();
  });

  it("never lets a folder that cannot be read stop the wave", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setTaskMemoryIoForTests({
      projectRootFor: () => "/repo",
      read: async () => {
        throw new Error("the drive is not mounted");
      },
      write: async () => undefined,
    });
    await expect(readTaskMemory(CONDUCTOR_ID, ROOT)).resolves.toEqual({
      version: 1,
      rootRequestId: ROOT,
      goal: "",
      waves: [],
      failedAttempts: [],
    });
  });
});

describe("reading a damaged document", () => {
  it("salvages the rows that still parse and drops the ones that do not", () => {
    const document = parseTaskMemoryDocument(
      JSON.stringify({
        version: 7,
        rootRequestId: "someone-elses-id",
        goal: "make the parser accept trailing commas",
        waves: [
          null,
          { attempt: 1 },
          {
            waveId: "wave-1",
            attempt: "two",
            verdict: "sideways",
            steps: [
              { role: "brigade", status: "exploded", summary: "patched it" },
              { summary: "no role, no row" },
            ],
          },
        ],
        failedAttempts: [
          { wave: 1, role: "brigade", what: "patched it", why: "the lexer" },
          { wave: 1, role: "qa", why: "no what, no row" },
          "not an object",
        ],
      }),
      ROOT,
    );
    // The file it was found under is the fact; the id inside it is a memento.
    expect(document.rootRequestId).toBe(ROOT);
    expect(document.goal).toBe("make the parser accept trailing commas");
    expect(document.waves).toHaveLength(1);
    expect(document.waves[0]).toMatchObject({
      waveId: "wave-1",
      attempt: 1,
      verdict: "undecided",
    });
    // An unrecognised status is read as `failed`, never as `completed`.
    expect(document.waves[0].steps).toEqual([
      {
        role: "brigade",
        status: "failed",
        summary: "patched it",
        decisions: [],
        artifacts: [],
        risks: [],
      },
    ]);
    expect(document.failedAttempts).toEqual([
      { wave: 1, role: "brigade", what: "patched it", why: "the lexer" },
    ]);
  });

  it("reads truncated and foreign files as an empty record rather than throwing", () => {
    for (const raw of ['{"version":1,"waves":[', "", "null", "[]", "12"]) {
      expect(parseTaskMemoryDocument(raw, ROOT)).toEqual({
        version: 1,
        rootRequestId: ROOT,
        goal: "",
        waves: [],
        failedAttempts: [],
      });
    }
  });

  it("still hands the next wave what it could salvage", async () => {
    useFakeFolder({
      [taskMemoryDocumentPath(ROOT)]:
        `{"version":1,"goal":"x","waves":[{"broken":`,
    });
    expect(
      await loadFailedAttemptsBlock({
        conductorSessionId: CONDUCTOR_ID,
        rootRequestId: ROOT,
        revisionCount: 1,
      }),
    ).toBeNull();

    useFakeFolder({
      [taskMemoryDocumentPath(ROOT)]: JSON.stringify({
        failedAttempts: [
          { wave: 1, role: "brigade", what: "patched it", why: "the lexer" },
        ],
        waves: "not a list",
      }),
    });
    expect(
      await loadFailedAttemptsBlock({
        conductorSessionId: CONDUCTOR_ID,
        rootRequestId: ROOT,
        revisionCount: 1,
      }),
    ).toContain("- wave 1 (brigade): patched it");
  });
});

describe("reading for the next wave", () => {
  it("is read only by a revision, never by a first wave", async () => {
    const reads: string[] = [];
    setTaskMemoryIoForTests({
      projectRootFor: () => "/repo",
      read: async (_root, path) => {
        reads.push(path);
        return JSON.stringify({
          failedAttempts: [
            { wave: 1, role: "brigade", what: "patched it", why: "" },
          ],
        });
      },
      write: async () => undefined,
    });
    expect(
      await loadFailedAttemptsBlock({
        conductorSessionId: CONDUCTOR_ID,
        rootRequestId: ROOT,
        revisionCount: 0,
      }),
    ).toBeNull();
    expect(reads).toEqual([]);
    expect(
      await loadFailedAttemptsBlock({
        conductorSessionId: CONDUCTOR_ID,
        rootRequestId: ROOT,
        revisionCount: 1,
      }),
    ).toContain(FAILED_ATTEMPTS_HEADING);
  });
});

describe("the request's goal", () => {
  it("is the first line of the operator message the root plan answered", () => {
    const messages = [
      user("ask-0", "an older question"),
      assistant("plan-0", "an older plan"),
      user("ask-1", "  \nMake the parser accept trailing commas\nand say why"),
      assistant("plan-1", "a plan"),
    ];
    expect(taskMemoryGoal(messages, "plan-1")).toBe(
      "Make the parser accept trailing commas",
    );
  });

  it("never reads a digest the app itself sent as the operator's request", () => {
    const digest: Message = {
      id: "digest-1",
      role: "user",
      created: 1,
      content: [{ type: "text", text: "WAVE REPORT DIGEST" }],
      metadata: { origin: "berdctl_cross_session" },
    };
    const messages = [user("ask-1", "The real request"), digest];
    expect(taskMemoryGoal(messages, "digest-1")).toBe("The real request");
  });

  it("falls back to what the caller knows when the transcript holds nothing", () => {
    expect(taskMemoryGoal([], "plan-1", "Conductor")).toBe("Conductor");
    expect(taskMemoryGoal([], "plan-1")).toBe("");
  });
});

describe("withRecordedWave", () => {
  it("orders the attempts by wave so the prompt reads chronologically", () => {
    let document = parseTaskMemoryDocument(null, ROOT);
    document = withRecordedWave(document, {
      waveId: "wave-2",
      attempt: 2,
      verdict: "undecided",
      steps: [
        taskMemoryStepOf({
          role: "qa",
          report: report({ status: "failed", summary: "second try" }),
        }),
      ],
    });
    document = withRecordedWave(document, {
      waveId: "wave-1",
      attempt: 1,
      verdict: "revise",
      steps: [
        taskMemoryStepOf({
          role: "brigade",
          report: report({ status: "failed", summary: "first try" }),
        }),
      ],
    });
    expect(document.failedAttempts.map((attempt) => attempt.what)).toEqual([
      "first try",
      "second try",
    ]);
  });
});
