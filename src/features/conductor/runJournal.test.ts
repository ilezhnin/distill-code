import { describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, string>());
/** Paths whose read rejects, as a held or unreadable file does. */
const unreadable = vi.hoisted(() => new Set<string>());

vi.mock("@/shared/api/distillStore", () => ({
  isDesktopRuntime: () => true,
  readDistillDocument: vi.fn(async (path: string) => {
    if (unreadable.has(path)) throw new Error("EBUSY");
    return files.get(path) ?? null;
  }),
  writeDistillDocument: vi.fn(async (path: string, contents: string) => {
    files.set(path, contents);
  }),
  getDistillRoot: async () => null,
  setDistillRoot: async () => undefined,
}));

import {
  appendRunEvent,
  diffGraphNodes,
  hasUnreadableRunJournal,
  resetRunJournalsForTests,
  RUN_JOURNAL_READ_RETRY_DELAYS_MS,
  runEventsFor,
  runJournalPath,
} from "./runJournal";
import type { WaveState } from "./waveEngine";
import type { SessionNode } from "./types";

function wave(over: Partial<WaveState> = {}): WaveState {
  return {
    waveId: "w1",
    conductorSessionId: "c1",
    planMessageId: "m1",
    rootRequestId: "m1",
    createdAt: 0,
    phase: "running",
    revisionCount: 0,
    digestAttempt: 0,
    steps: [
      {
        stepIndex: 0,
        role: "brigade",
        subtask: "do it",
        access: [],
        phase: "pending",
      },
    ],
    ...over,
  };
}

function node(over: Partial<SessionNode> = {}): SessionNode {
  return {
    sessionId: "s1",
    projectId: "p1",
    role: "worker",
    managedBy: "wave",
    parentSessionId: "c1",
    rootConductorId: "c1",
    runId: "r1",
    harnessId: "goose",
    displayName: "Bohr",
    status: "starting",
    waveId: "w1",
    stepIndex: 0,
    ...over,
  };
}

const NOW = 1_000;

describe("diffGraphNodes", () => {
  const waveById = (id: string) => (id === "w1" ? wave() : undefined);

  it("records the spawn with the model, effort and fast mode the step actually landed on", () => {
    // The whole reason this exists: four executors died before doing anything
    // because they were spawned onto a model the harness would not serve, and
    // nothing anywhere kept a record of which model that was. The effort is
    // its own field now, so the journal states it rather than a folded id.
    const events = diffGraphNodes(
      null,
      { s1: node({ modelId: "gpt-5.6-sol", effort: "low", fast: false }) },
      {},
      null,
      waveById,
      NOW,
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("step-spawned");
    expect(events[0].detail).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "low",
      fast: false,
      harness: "goose",
    });
  });
});

describe("runJournalPath", () => {
  it("cannot be talked into leaving the runs folder", () => {
    expect(runJournalPath("../../etc/passwd")).toBe(
      "runs/______etc_passwd.json",
    );
  });
});

describe("the journal in the folder", () => {
  it("keeps what a previous run wrote for the same wave", async () => {
    files.set(
      runJournalPath("w-restart"),
      JSON.stringify({
        version: 1,
        waveId: "w-restart",
        events: [
          {
            seq: 0,
            at: 1,
            kind: "wave-admitted",
            waveId: "w-restart",
            conductorSessionId: "c1",
            rootRequestId: "m1",
          },
        ],
      }),
    );

    appendRunEvent({
      at: 2,
      kind: "wave-phase",
      waveId: "w-restart",
      conductorSessionId: "c1",
      rootRequestId: "m1",
    });

    await vi.waitFor(() =>
      expect(runEventsFor("w-restart").map((event) => event.seq)).toEqual([
        0, 1,
      ]),
    );
    await vi.waitFor(() => {
      const raw = files.get(runJournalPath("w-restart")) ?? "{}";
      expect(JSON.parse(raw).events).toHaveLength(2);
    });
  });

  it("never overwrites a journal whose file could not be read", async () => {
    // A read that fails is not an empty journal. Settling it as empty let this
    // session's handful of events replace the whole trace of the previous run —
    // and LAWS/WAVES.md requires that record to be readable without the app.
    const path = runJournalPath("w-unreadable");
    const stored = JSON.stringify({
      version: 1,
      waveId: "w-unreadable",
      events: [
        {
          seq: 0,
          at: 1,
          kind: "wave-admitted",
          waveId: "w-unreadable",
          conductorSessionId: "c1",
          rootRequestId: "m1",
        },
      ],
    });
    files.set(path, stored);
    unreadable.add(path);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      appendRunEvent({
        at: 2,
        kind: "wave-phase",
        waveId: "w-unreadable",
        conductorSessionId: "c1",
        rootRequestId: "m1",
      });

      await vi.waitFor(() => expect(hasUnreadableRunJournal()).toBe(true), {
        timeout: 5_000,
      });
      // Every attempt was made before giving up: the first read plus one per
      // backoff step.
      expect(consoleError).toHaveBeenCalled();
      // The file still holds the previous run, byte for byte…
      expect(files.get(path)).toBe(stored);
      // …while this session's event is still readable in memory.
      expect(runEventsFor("w-unreadable").map((event) => event.kind)).toEqual([
        "wave-phase",
      ]);

      // A later event does not write either, so nothing can land out of order.
      appendRunEvent({
        at: 3,
        kind: "wave-closed",
        waveId: "w-unreadable",
        conductorSessionId: "c1",
        rootRequestId: "m1",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(files.get(path)).toBe(stored);
    } finally {
      consoleError.mockRestore();
      unreadable.delete(path);
    }
  });

  it("replays the held events once a retried read succeeds", async () => {
    expect(RUN_JOURNAL_READ_RETRY_DELAYS_MS.length).toBeGreaterThan(0);
    // The previous case deliberately leaves one journal unreadable; this one is
    // about the recovery, so it starts from a clean map.
    resetRunJournalsForTests();
    const path = runJournalPath("w-retry");
    files.set(
      path,
      JSON.stringify({
        version: 1,
        waveId: "w-retry",
        events: [
          {
            seq: 0,
            at: 1,
            kind: "wave-admitted",
            waveId: "w-retry",
            conductorSessionId: "c1",
            rootRequestId: "m1",
          },
        ],
      }),
    );
    unreadable.add(path);

    appendRunEvent({
      at: 2,
      kind: "wave-phase",
      waveId: "w-retry",
      conductorSessionId: "c1",
      rootRequestId: "m1",
    });
    // The first read has already failed; the file becomes readable before the
    // retries run out.
    unreadable.delete(path);

    await vi.waitFor(
      () => {
        const raw = files.get(path) ?? "{}";
        expect(JSON.parse(raw).events).toHaveLength(2);
      },
      { timeout: 5_000 },
    );
    expect(runEventsFor("w-retry").map((event) => event.seq)).toEqual([0, 1]);
    expect(hasUnreadableRunJournal()).toBe(false);
  });
});
