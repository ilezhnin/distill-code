import { describe, expect, it } from "vitest";
import { runSummary } from "../__tests__/fixtures";
import type { RunSummary } from "../types";
import { RUN_WINDOW_MS } from "./benchmarkPlan";
import { roughSpan, runPace } from "./benchmarkRunPace";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 10, 14, 18, 0, 0);

const run = (rest: Partial<RunSummary>): RunSummary => ({
  ...runSummary,
  state: "running",
  createdAt: NOW - 2 * HOUR,
  cellCount: 100,
  settledCellCount: 20,
  ...rest,
});

describe("runPace", () => {
  it("reads what is left from the time at work over the tests settled", () => {
    expect(runPace(run({}), NOW)).toEqual({
      remainingMs: 8 * HOUR,
      closesAt: NOW - 2 * HOUR + RUN_WINDOW_MS,
      pastWindow: false,
    });
  });

  it("leaves pauses out of the time at work and moves the window by them", () => {
    const pace = runPace(
      run({
        createdAt: NOW - 20 * HOUR,
        pausedMs: 17 * HOUR,
        pausedSince: NOW - HOUR,
      }),
      NOW,
    );
    // Twenty hours old, eighteen of them resting: two at work.
    expect(pace?.remainingMs).toBe(8 * HOUR);
    expect(pace?.closesAt).toBe(NOW - 20 * HOUR + RUN_WINDOW_MS + 18 * HOUR);
    expect(pace?.pastWindow).toBe(false);
  });

  it("says a run would outlast its window only with enough tests behind the pace", () => {
    const slow = { createdAt: NOW - 20 * HOUR };
    expect(runPace(run(slow), NOW)?.pastWindow).toBe(true);
    // The same pace read from a handful of tests is shown, not believed.
    const early = runPace(
      run({ ...slow, cellCount: 50, settledCellCount: 10 }),
      NOW,
    );
    expect(early?.remainingMs).toBe(80 * HOUR);
    expect(early?.pastWindow).toBe(false);
  });

  it("estimates nothing for a run that stands, has settled too little, or has nothing left", () => {
    expect(runPace(run({ state: "paused" }), NOW)).toBeNull();
    expect(runPace(run({ state: "pausing" }), NOW)).toBeNull();
    expect(runPace(run({ settledCellCount: 4 }), NOW)).toBeNull();
    expect(runPace(run({ settledCellCount: 100 }), NOW)).toBeNull();
    expect(runPace(run({ createdAt: NOW + HOUR }), NOW)).toBeNull();
  });
});

describe("roughSpan", () => {
  it("rounds a span the way an estimate is said", () => {
    expect(roughSpan(40_000)).toBe("5m");
    expect(roughSpan(33 * MINUTE)).toBe("35m");
    expect(roughSpan(58 * MINUTE)).toBe("1h");
    expect(roughSpan(HOUR)).toBe("1h");
    expect(roughSpan(5 * HOUR + 38 * MINUTE)).toBe("5h 40m");
    expect(roughSpan(9 * HOUR + 58 * MINUTE)).toBe("10h");
    expect(roughSpan(27.4 * HOUR)).toBe("27h");
    expect(roughSpan(80 * HOUR)).toBe("3d");
  });
});
