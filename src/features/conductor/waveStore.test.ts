import { beforeEach, describe, expect, it } from "vitest";

import {
  WAVE_PHASES,
  WAVE_STEP_PHASES,
  createWaveState,
  type WaveState,
} from "./waveEngine";
import {
  CONDUCTOR_WAVES_STORAGE_KEY,
  MAX_WAVE_TOMBSTONES,
  emptyWaveEngineState,
  getWaveEngineState,
  hasWaveTombstone,
  parseWaveEngineState,
  pruneOrphanedWaves,
  resetWaveEngineStateCache,
  setWaveEngineState,
  withWave,
  withWaveTombstone,
  withoutWave,
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
  it("rejects payloads that are not objects at all", () => {
    expect(parseWaveEngineState(null)).toEqual(emptyWaveEngineState());
    expect(parseWaveEngineState("nope")).toEqual(emptyWaveEngineState());
  });

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

  it("round-trips a revision wave's carried reports", () => {
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
            status: "completed",
            summary: "Found three",
            decisions: [],
            artifacts: [],
            risks: [],
            needsOperator: false,
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

  it("drops an unreadable carried report rather than the whole wave", () => {
    const parsed = parseWaveEngineState({
      version: 2,
      waves: [
        {
          waveId: "w1",
          conductorSessionId: "conductor-1",
          planMessageId: "plan-1",
          phase: "running",
          rootRequestId: "plan-1",
          revisionCount: 1,
          digestAttempt: 0,
          steps: [
            {
              stepIndex: 0,
              role: "scout",
              subtask: "Look",
              access: "all",
              phase: "pending",
            },
          ],
          carriedReports: [{ stepIndex: 0, role: "scout" }],
        },
      ],
      tombstones: [],
    });
    expect(parsed.waves).toHaveLength(1);
    expect(parsed.waves[0].carriedReports).toBeUndefined();
  });

  it("round-trips a wave and its tombstone", () => {
    const state = withWaveTombstone(
      withWave(emptyWaveEngineState(), wave("w1")),
      {
        planMessageId: "plan-w1",
        conductorSessionId: "conductor-1",
        outcome: "spawned",
        at: 5,
      },
    );
    expect(parseWaveEngineState(JSON.parse(JSON.stringify(state)))).toEqual(
      state,
    );
  });

  it("round-trips the E3a git counts and the 5b degradation mark, and drops junk values", () => {
    const base = wave("w1");
    const state = withWave(emptyWaveEngineState(), {
      ...base,
      gitDirtyAtAdmission: 3,
      gitDirtyAtDigest: 7,
      gitDigestProbed: true,
      steps: [{ ...base.steps[0], reportDegraded: true }],
    });
    expect(parseWaveEngineState(JSON.parse(JSON.stringify(state)))).toEqual(
      state,
    );

    // A restart must not resurrect these from garbage: a negative or
    // non-integer count reads as "never measured", a non-true flag as
    // "never degraded / never probed".
    const parsed = parseWaveEngineState({
      version: 2,
      waves: [
        {
          ...JSON.parse(JSON.stringify(base)),
          gitDirtyAtAdmission: -1,
          gitDirtyAtDigest: 1.5,
          gitDigestProbed: "yes",
          steps: [{ ...base.steps[0], reportDegraded: "yes" }],
        },
      ],
      tombstones: [],
    });
    expect(parsed.waves[0]?.gitDirtyAtAdmission).toBeUndefined();
    expect(parsed.waves[0]?.gitDirtyAtDigest).toBeUndefined();
    expect(parsed.waves[0]?.gitDigestProbed).toBeUndefined();
    expect(parsed.waves[0]?.steps[0]?.reportDegraded).toBeUndefined();
  });

  it("survives every phase either union can hold", () => {
    // The C1 regression, as a property over the unions themselves: a phase
    // that exists in `waveEngine.ts` but not in this module's guard used to
    // make `parseStep` return null, which dropped the whole wave — its live
    // children orphaned, its tombstone still in place so nothing was ever
    // re-admitted, and no notice anywhere. Enumerating both unions is what
    // stops the two schemas drifting apart again.
    for (const stepPhase of WAVE_STEP_PHASES) {
      for (const phase of WAVE_PHASES) {
        const stored: WaveState = {
          ...wave(`w-${phase}-${stepPhase}`),
          phase,
          steps: [
            {
              stepIndex: 0,
              role: "scout",
              subtask: "Look",
              access: [],
              phase: stepPhase,
              sessionId: "child-0",
              runId: "run-0",
            },
          ],
        };
        const state = withWave(emptyWaveEngineState(), stored);
        const parsed = parseWaveEngineState(JSON.parse(JSON.stringify(state)));
        expect(
          parsed.waves,
          `wave phase "${phase}" with step phase "${stepPhase}" did not survive`,
        ).toHaveLength(1);
        expect(parsed.waves[0].phase).toBe(phase);
        expect(parsed.waves[0].steps[0].phase).toBe(stepPhase);
      }
    }
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

  it("drops a wave whose every step is unreadable", () => {
    const parsed = parseWaveEngineState({
      version: 1,
      waves: [
        {
          waveId: "w1",
          conductorSessionId: "conductor-1",
          planMessageId: "plan-1",
          createdAt: 1,
          steps: [{ stepIndex: 0, role: "scout", subtask: "Look" }],
        },
      ],
      tombstones: [],
    });
    expect(parsed.waves).toEqual([]);
  });

  it("round-trips the Q5 retry note and rejects a malformed one", () => {
    const parked: WaveState = {
      ...wave("w-parked"),
      phase: "needsOperator",
      digestAttempt: 1,
      verdictIssue: { reason: "invalid", detail: 'Unknown verdict "ok".' },
    };
    const state = withWave(emptyWaveEngineState(), parked);
    expect(parseWaveEngineState(JSON.parse(JSON.stringify(state)))).toEqual(
      state,
    );

    const bogus = parseWaveEngineState({
      version: 2,
      waves: [{ ...parked, verdictIssue: { reason: "whatever" } }],
      tombstones: [],
    });
    expect(bogus.waves).toHaveLength(1);
    expect(bogus.waves[0].verdictIssue).toBeUndefined();
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

  it("skips malformed tombstones without losing the good ones", () => {
    const parsed = parseWaveEngineState({
      version: 1,
      waves: [],
      tombstones: [
        { planMessageId: "", conductorSessionId: "c", outcome: "spawned" },
        { planMessageId: "p2", conductorSessionId: "c", outcome: "nope" },
        { planMessageId: "p3", conductorSessionId: "c", outcome: "rejected" },
      ],
    });
    expect(parsed.tombstones.map((entry) => entry.planMessageId)).toEqual([
      "p3",
    ]);
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

  it("drops the oldest entries past the cap", () => {
    let state = emptyWaveEngineState();
    for (let index = 0; index < MAX_WAVE_TOMBSTONES + 10; index += 1) {
      state = withWaveTombstone(state, {
        planMessageId: `plan-${index}`,
        conductorSessionId: "conductor-1",
        outcome: "spawned",
        at: index,
      });
    }
    expect(state.tombstones).toHaveLength(MAX_WAVE_TOMBSTONES);
    expect(hasWaveTombstone(state, "plan-0")).toBe(false);
    expect(hasWaveTombstone(state, `plan-${MAX_WAVE_TOMBSTONES + 9}`)).toBe(
      true,
    );
  });
});

describe("wave records", () => {
  it("upserts, removes and prunes by conductor", () => {
    let state = withWave(emptyWaveEngineState(), wave("w1"));
    state = withWave(state, wave("w2", "conductor-2"));
    expect(state.waves).toHaveLength(2);

    const replaced = withWave(state, {
      ...wave("w1"),
      createdAt: 99,
    });
    expect(replaced.waves).toHaveLength(2);
    expect(
      replaced.waves.find((entry) => entry.waveId === "w1")?.createdAt,
    ).toBe(99);

    expect(withoutWave(replaced, "w1").waves.map((w) => w.waveId)).toEqual([
      "w2",
    ]);
    expect(
      pruneOrphanedWaves(replaced, new Set(["conductor-1"])).waves.map(
        (w) => w.waveId,
      ),
    ).toEqual(["w1"]);
  });
});

describe("persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetWaveEngineStateCache();
  });

  it("writes through to localStorage and reloads", () => {
    setWaveEngineState(withWave(emptyWaveEngineState(), wave("w1")));
    expect(window.localStorage.getItem(CONDUCTOR_WAVES_STORAGE_KEY)).toContain(
      "w1",
    );

    resetWaveEngineStateCache();
    expect(getWaveEngineState().waves.map((entry) => entry.waveId)).toEqual([
      "w1",
    ]);
  });

  it("survives a corrupt key", () => {
    window.localStorage.setItem(CONDUCTOR_WAVES_STORAGE_KEY, "{not json");
    resetWaveEngineStateCache();
    expect(getWaveEngineState()).toEqual(emptyWaveEngineState());
  });
});
