import { describe, expect, it } from "vitest";

import { diffGraphNodes, diffWaveStates, runJournalPath } from "./runJournal";
import type { WaveState } from "./waveEngine";
import { emptyWaveEngineState, type WaveEngineState } from "./waveStore";
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
