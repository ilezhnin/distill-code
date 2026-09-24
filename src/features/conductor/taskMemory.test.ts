import { afterEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/shared/types/messages";

import type { StructuredReport } from "./types";
import {
  FAILED_ATTEMPTS_HEADING,
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

afterEach(() => {
  resetTaskMemoryIoForTests();
  vi.restoreAllMocks();
});

describe("the stored document", () => {
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

  it("does not lose an update that overlaps another on the same file", async () => {
    const files = useFakeFolder();
    // Both halves of every update cross the IPC bridge; with the read and the
    // write a tick apart, two unserialized updates would both read the empty
    // folder and the second write would drop the first one's wave.
    setTaskMemoryIoForTests({
      projectRootFor: () => "/repo",
      read: async (_root, path) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return files.get(path) ?? null;
      },
      write: async (_root, path, contents) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        files.set(path, contents);
      },
    });
    await Promise.all([
      recordWaveInTaskMemory({
        conductorSessionId: CONDUCTOR_ID,
        rootRequestId: ROOT,
        goal: "a goal",
        wave: { waveId: "wave-1", attempt: 1, verdict: "undecided", steps: [] },
      }),
      recordTaskMemoryVerdict({
        conductorSessionId: CONDUCTOR_ID,
        rootRequestId: ROOT,
        waveId: "wave-1",
        verdict: "revise",
      }),
    ]);
    expect(stored(files).waves).toHaveLength(1);
    expect(stored(files).waves[0].verdict).toBe("revise");
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
  it("never reads a digest the app itself sent as the operator's request", () => {
    const digest: Message = {
      id: "digest-1",
      role: "user",
      created: 1,
      content: [{ type: "text", text: "WAVE REPORT DIGEST" }],
      metadata: { origin: "distillctl_cross_session" },
    };
    const messages = [user("ask-1", "The real request"), digest];
    expect(taskMemoryGoal(messages, "digest-1")).toBe("The real request");
  });
});
