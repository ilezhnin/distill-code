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
  diffWaveStates,
  hasUnreadableRunJournal,
  installRunJournal,
  resetRunJournalsForTests,
  RUN_JOURNAL_READ_RETRY_DELAYS_MS,
  runEventsFor,
  runJournalPath,
} from "./runJournal";
import type { WaveState } from "./waveEngine";
import {
  emptyWaveEngineState,
  setWaveEngineState,
  type WaveEngineState,
} from "./waveStore";
import type { SessionNode, StructuredReport } from "./types";

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

function state(waves: WaveState[]): WaveEngineState {
  return { ...emptyWaveEngineState(), waves };
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

function report(over: Partial<StructuredReport> = {}): StructuredReport {
  return {
    runId: "r1",
    status: "completed",
    summary: "did the thing",
    decisions: [],
    artifacts: [],
    risks: [],
    needsOperator: false,
    nextSuggestedTask: null,
    ...over,
  };
}

const NOW = 1_000;

describe("diffWaveStates", () => {
  it("opens a new wave with its plan and every step's starting phase", () => {
    const events = diffWaveStates(null, state([wave()]), NOW);
    expect(events.map((event) => event.kind)).toEqual([
      "wave-admitted",
      "step-phase",
    ]);
    expect(events[0].detail).toMatchObject({ steps: 1, roles: "brigade" });
    expect(events[0].rootRequestId).toBe("m1");
  });

  it("records a phase change on the wave and on one step", () => {
    const before = state([wave()]);
    const after = state([
      wave({
        phase: "awaitingVerdict",
        steps: [{ ...wave().steps[0], phase: "spawned" }],
      }),
    ]);
    const events = diffWaveStates(before, after, NOW);
    expect(events.map((event) => event.kind)).toEqual([
      "wave-phase",
      "step-phase",
    ]);
    expect(events[0].detail).toMatchObject({
      from: "running",
      to: "awaitingVerdict",
    });
    expect(events[1].detail).toMatchObject({
      from: "pending",
      to: "spawned",
    });
    expect(events[1].stepIndex).toBe(0);
  });

  it("says nothing when nothing moved", () => {
    const same = state([wave()]);
    expect(diffWaveStates(same, same, NOW)).toEqual([]);
  });

  it("closes a wave the engine dropped", () => {
    // Accepted and superseded waves leave the state entirely; without this
    // the trace would just stop mid-run with no ending.
    const events = diffWaveStates(
      state([wave({ phase: "accepted" })]),
      state([]),
      NOW,
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("wave-closed");
    expect(events[0].detail).toMatchObject({ phase: "accepted" });
  });
});

describe("diffGraphNodes", () => {
  const waveById = (id: string) => (id === "w1" ? wave() : undefined);

  it("records the spawn with the model the step actually landed on", () => {
    // The whole reason this exists: four executors died before doing anything
    // because they were spawned onto a model the harness would not serve, and
    // nothing anywhere kept a record of which model that was.
    const events = diffGraphNodes(
      null,
      { s1: node({ modelId: "gpt-5.6-sol[low]" }) },
      {},
      null,
      waveById,
      NOW,
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("step-spawned");
    expect(events[0].detail).toMatchObject({
      model: "gpt-5.6-sol[low]",
      harness: "goose",
    });
  });

  it("records a status change once, not on every write", () => {
    const before = { s1: node() };
    const after = { s1: node({ status: "failed" as const }) };
    expect(
      diffGraphNodes(before, after, {}, null, waveById, NOW).map(
        (event) => event.detail,
      ),
    ).toEqual([{ from: "starting", to: "failed", name: "Bohr" }]);
    expect(diffGraphNodes(after, after, {}, null, waveById, NOW)).toEqual([]);
  });

  it("records a report the first time it appears", () => {
    const nodes = { s1: node() };
    const reports = { r1: report({ risks: ["one"] }) };
    const first = diffGraphNodes(nodes, nodes, reports, {}, waveById, NOW);
    expect(first.map((event) => event.kind)).toEqual(["step-report"]);
    expect(first[0].detail).toMatchObject({ status: "completed", risks: 1 });
    expect(
      diffGraphNodes(nodes, nodes, reports, reports, waveById, NOW),
    ).toEqual([]);
  });

  it("ignores sessions that belong to no wave", () => {
    // Ordinary chats and hand-started orchestrators are not runs, and tracing
    // them would fill the folder with journals nothing will ever read.
    expect(
      diffGraphNodes(
        null,
        { s1: node({ waveId: undefined }) },
        {},
        null,
        waveById,
        NOW,
      ),
    ).toEqual([]);
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

  it("does not report the folder's executors as spawned just now", async () => {
    // graph.json usually lands after waves.json (it is much larger), so the
    // journal of every persisted wave used to gain a "spawned" and a "report
    // arrived" for each of its steps, stamped at startup — a reader of the
    // record would see executors starting after the wave was already parked.
    const { CONDUCTOR_GRAPH_DOCUMENT } = await import("./conductorDocuments");
    const {
      hydrateConductorGraph,
      resetConductorGraphHydrationForTests,
      useConductorGraphStore,
    } = await import("./conductorGraphStore");
    files.set(
      CONDUCTOR_GRAPH_DOCUMENT,
      JSON.stringify({
        version: 1,
        nodes: [node({ sessionId: "s-old", runId: "r-old" })],
        reports: [report({ runId: "r-old" })],
      }),
    );
    resetConductorGraphHydrationForTests();
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    const stop = installRunJournal();
    try {
      setWaveEngineState(state([wave({ waveId: "w1" })]), { hydration: true });
      await hydrateConductorGraph();
      expect(runEventsFor("w1")).toHaveLength(0);

      // An executor that really does move now is still recorded.
      useConductorGraphStore
        .getState()
        .patchNode("s-old", { status: "completed" });
      expect(runEventsFor("w1").map((event) => event.kind)).toEqual([
        "step-status",
      ]);
    } finally {
      stop();
      resetConductorGraphHydrationForTests();
      useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    }
  });

  it("does not report the previous run's waves as newly admitted", () => {
    const stop = installRunJournal();
    try {
      setWaveEngineState(state([wave({ waveId: "w-hydrated" })]), {
        hydration: true,
      });
      expect(runEventsFor("w-hydrated")).toHaveLength(0);

      setWaveEngineState(
        state([wave({ waveId: "w-hydrated", phase: "digestPending" })]),
      );
      expect(runEventsFor("w-hydrated").map((event) => event.kind)).toEqual([
        "wave-phase",
      ]);
    } finally {
      stop();
    }
  });
});
