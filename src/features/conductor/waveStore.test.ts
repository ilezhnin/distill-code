import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setConductorProcessStartedAtForTests } from "./processClock";
import { createWaveState, type WaveState } from "./waveEngine";
import {
  CONDUCTOR_WAVES_STORAGE_KEY,
  emptyWaveEngineState,
  getWaveEngineState,
  hasWaveTombstone,
  isSupersededPlanMessage,
  newestProcessedMessageAt,
  parseWaveEngineState,
  resetWaveEngineStateCache,
  withProcessedMessageWatermark,
  withRemappedConductorSessionId,
  withWave,
  withWaveTombstone,
} from "./waveStore";

function wave(waveId: string, conductorSessionId = "conductor-1"): WaveState {
  return createWaveState({
    waveId,
    conductorSessionId,
    planMessageId: `plan-${waveId}`,
    steps: [{ role: "scout", subtask: "Look", access: [] }],
    createdAt: 1,
  });
}

describe("parseWaveEngineState", () => {
  it("salvages readable entries from an unknown version instead of wiping", () => {
    // A version-gated wipe erased the tombstones with the waves, and the same
    // plan then respawned duplicate children after reload (risk №5). Entries
    // this build can validate field-by-field must survive any version stamp.
    const parsed = parseWaveEngineState({
      version: 3,
      futureField: { anything: true },
      waves: [
        {
          waveId: "w1",
          conductorSessionId: "conductor-1",
          planMessageId: "plan-1",
          createdAt: 7,
          steps: [
            {
              stepIndex: 0,
              role: "scout",
              subtask: "Look",
              access: [],
              phase: "pending",
            },
          ],
          phase: "running",
          revisions: 0,
        },
      ],
      tombstones: [
        {
          planMessageId: "plan-1",
          conductorSessionId: "conductor-1",
          outcome: "spawned",
          at: 7,
        },
      ],
    });
    expect(parsed.version).toBe(2);
    expect(parsed.waves).toHaveLength(1);
    expect(parsed.tombstones).toHaveLength(1);
  });

  it("migrates a v1 wave into the closed loop without losing it", () => {
    const parsed = parseWaveEngineState({
      version: 1,
      waves: [
        {
          waveId: "w1",
          conductorSessionId: "conductor-1",
          planMessageId: "plan-1",
          createdAt: 7,
          steps: [
            {
              stepIndex: 0,
              role: "scout",
              subtask: "Look",
              access: [],
              phase: "spawned",
              sessionId: "child-0",
              runId: "run-0",
            },
          ],
        },
      ],
      tombstones: [
        {
          planMessageId: "plan-1",
          conductorSessionId: "c",
          outcome: "spawned",
        },
      ],
    });
    expect(parsed.version).toBe(2);
    expect(parsed.tombstones).toHaveLength(1);
    const [migrated] = parsed.waves;
    // Everything a v1 wave held survives verbatim…
    expect(migrated.steps).toEqual([
      {
        stepIndex: 0,
        role: "scout",
        subtask: "Look",
        access: [],
        phase: "spawned",
        sessionId: "child-0",
        runId: "run-0",
      },
    ]);
    expect(migrated.createdAt).toBe(7);
    // …and the loop fields take the only values a pre-3a wave could have had.
    expect(migrated.phase).toBe("running");
    expect(migrated.rootRequestId).toBe("plan-1");
    expect(migrated.revisionCount).toBe(0);
    expect(migrated.digestAttempt).toBe(0);
    expect(migrated.carriedReports).toBeUndefined();
  });

  it("round-trips a blocked carried report with its reason", () => {
    // A reload must not launder "the step could not be done" into a plain
    // completed entry — the reason is what the reader of the handoff acts on.
    const revision = createWaveState({
      waveId: "w2",
      conductorSessionId: "conductor-1",
      planMessageId: "verdict-1",
      steps: [{ role: "scout", subtask: "Look again", access: "all" }],
      createdAt: 2,
      rootRequestId: "plan-1",
      revisionCount: 1,
      carriedReports: [
        {
          stepIndex: 0,
          role: "scout",
          subtask: "Look",
          fromPreviousWave: true,
          report: {
            runId: "run-0",
            status: "blocked",
            reason: "the named file does not exist",
            summary: "Could not start",
            decisions: [],
            artifacts: [],
            risks: [],
            needsOperator: true,
            nextSuggestedTask: null,
          },
        },
      ],
    });
    const state = withWave(emptyWaveEngineState(), revision);
    expect(parseWaveEngineState(JSON.parse(JSON.stringify(state)))).toEqual(
      state,
    );
  });

  it("round-trips a step's effort and fast mode, and drops junk values", () => {
    // A resumed step is spawned from this record: one that lost its effort
    // would run at the ranking's or the model's default instead of the plan's.
    const base = wave("w1");
    const state = withWave(emptyWaveEngineState(), {
      ...base,
      steps: [{ ...base.steps[0], effort: "xhigh", fast: false }],
    });
    expect(parseWaveEngineState(JSON.parse(JSON.stringify(state)))).toEqual(
      state,
    );

    const junk = parseWaveEngineState({
      version: 2,
      waves: [
        {
          ...JSON.parse(JSON.stringify(base)),
          steps: [{ ...base.steps[0], effort: "   ", fast: "yes" }],
        },
      ],
      tombstones: [],
    });
    expect(junk.waves[0]?.steps).toHaveLength(1);
    expect(junk.waves[0]?.steps[0]?.effort).toBeUndefined();
    expect(junk.waves[0]?.steps[0]?.fast).toBeUndefined();
  });

  it("drops an unreadable step, and keeps the rest of the wave", () => {
    // Dropping the wave is the most destructive answer available to a parse
    // miss: the children keep running under a record that no longer exists.
    const parsed = parseWaveEngineState({
      version: 1,
      waves: [
        {
          waveId: "w1",
          conductorSessionId: "conductor-1",
          planMessageId: "plan-1",
          createdAt: 1,
          steps: [
            {
              stepIndex: 0,
              role: "scout",
              subtask: "Look",
              access: [],
              phase: "spawned",
              sessionId: "child-0",
              runId: "run-0",
            },
            { stepIndex: 1, role: "qa", subtask: "Check" },
          ],
        },
      ],
      tombstones: [],
    });
    expect(parsed.waves).toHaveLength(1);
    expect(parsed.waves[0].steps).toHaveLength(1);
    expect(parsed.waves[0].steps[0]).toMatchObject({
      stepIndex: 0,
      sessionId: "child-0",
    });
  });

  it('keeps only [] or "all" access values', () => {
    const parsed = parseWaveEngineState({
      version: 1,
      waves: [
        {
          waveId: "w1",
          conductorSessionId: "conductor-1",
          planMessageId: "plan-1",
          steps: [
            {
              stepIndex: 0,
              role: "scout",
              subtask: "Look",
              access: [1],
              phase: "pending",
            },
          ],
        },
      ],
      tombstones: [],
    });
    expect(parsed.waves).toEqual([]);
  });
});

describe("tombstones", () => {
  it("is idempotent per plan message", () => {
    const entry = {
      planMessageId: "plan-1",
      conductorSessionId: "conductor-1",
      outcome: "rejected" as const,
      at: 1,
    };
    const once = withWaveTombstone(emptyWaveEngineState(), entry);
    const twice = withWaveTombstone(once, { ...entry, at: 2 });
    expect(twice).toBe(once);
    expect(hasWaveTombstone(twice, "plan-1")).toBe(true);
  });
});

describe("the per-conductor watermark", () => {
  afterEach(() => {
    setConductorProcessStartedAtForTests(null);
  });

  it("only moves forward, and calls anything at or before it superseded", () => {
    // Every stamp here is decades before this process started, so the
    // pre-process requirement is satisfied and the marks alone decide.
    setConductorProcessStartedAtForTests(() => 1_000_000);
    let state = withProcessedMessageWatermark(
      emptyWaveEngineState(),
      "conductor-1",
      5_000,
    );
    expect(newestProcessedMessageAt(state, "conductor-1")).toBe(5_000);
    // An older message settling late must not reopen the window.
    state = withProcessedMessageWatermark(state, "conductor-1", 2_000);
    expect(newestProcessedMessageAt(state, "conductor-1")).toBe(5_000);
    state = withProcessedMessageWatermark(state, "conductor-1", 9_000);
    expect(newestProcessedMessageAt(state, "conductor-1")).toBe(9_000);

    expect(isSupersededPlanMessage(state, "conductor-1", 8_999)).toBe(true);
    // The mark's own message, coming round again on a replay.
    expect(isSupersededPlanMessage(state, "conductor-1", 9_000)).toBe(true);
    expect(isSupersededPlanMessage(state, "conductor-1", 9_001)).toBe(false);
    // Another conductor has its own mark, and an unstamped message is left to
    // the tombstones.
    expect(isSupersededPlanMessage(state, "conductor-2", 1)).toBe(false);
    expect(isSupersededPlanMessage(state, "conductor-1", 0)).toBe(false);
  });

  it("follows a conductor promoted from its draft id", () => {
    const state = withRemappedConductorSessionId(
      withProcessedMessageWatermark(emptyWaveEngineState(), "draft-1", 4_000),
      "draft-1",
      "backend-1",
    );
    expect(newestProcessedMessageAt(state, "draft-1")).toBe(0);
    expect(newestProcessedMessageAt(state, "backend-1")).toBe(4_000);
  });
});

describe("persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetWaveEngineStateCache();
  });

  it("survives a corrupt key", () => {
    window.localStorage.setItem(CONDUCTOR_WAVES_STORAGE_KEY, "{not json");
    resetWaveEngineStateCache();
    expect(getWaveEngineState()).toEqual(emptyWaveEngineState());
  });
});
