import { beforeEach, describe, expect, it } from "vitest";

import { createWaveState, type WaveState } from "./waveEngine";
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
  it("rejects anything that is not a version 1 payload", () => {
    expect(parseWaveEngineState(null)).toEqual(emptyWaveEngineState());
    expect(parseWaveEngineState({ version: 2 })).toEqual(
      emptyWaveEngineState(),
    );
    expect(parseWaveEngineState("nope")).toEqual(emptyWaveEngineState());
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

  it("drops a wave with an unreadable step rather than resuming it wrong", () => {
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
