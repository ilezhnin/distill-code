import { afterEach, describe, expect, it } from "vitest";
import { runSummary } from "../__tests__/fixtures";
import type { RunSummary } from "../types";
import { RUN_WINDOW_MS } from "./benchmarkPlan";
import { observeRunPace, roughSpan, runPace } from "./benchmarkRunPace";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 10, 14, 18, 0, 0);

const run = (rest: Partial<RunSummary>): RunSummary => ({
  ...runSummary,
  id: "paced",
  state: "running",
  createdAt: NOW - 16 * HOUR,
  cellCount: 346,
  settledCellCount: 75,
  ...rest,
});
/** The run as it stood `minutesAgo`, with so many tests settled. */
const watch = (minutesAgo: number, settled: number, rest = {}) =>
  observeRunPace(
    run({ settledCellCount: settled, ...rest }),
    NOW - minutesAgo * MINUTE,
  );

afterEach(() => {
  // A run that stands keeps no pace.
  observeRunPace(run({ state: "paused" }), NOW);
});

describe("runPace", () => {
  it("reads what is left from the stretch watched, not from the run's whole life", () => {
    // Sixteen hours old with 75 of 346 settled, most of them long ago; over
    // the half hour watched it settled fifteen more.
    watch(30, 60);
    watch(20, 66);
    watch(5, 75);
    expect(runPace(run({}), NOW)).toEqual({
      remainingMs: (30 * MINUTE * (346 - 75)) / 15,
      watchedMs: 30 * MINUTE,
      closesAt: NOW - 16 * HOUR + RUN_WINDOW_MS,
      pastWindow: true,
    });
  });

  it("reads no further back than its window, and counts the time since the last test settled", () => {
    // An hour and a half ago the run crawled; the window holds the last 45
    // minutes or a little more.
    watch(90, 10);
    watch(80, 11);
    watch(50, 12);
    watch(40, 30);
    watch(10, 60);
    const pace = runPace(run({ settledCellCount: 60 }), NOW);
    expect(pace?.watchedMs).toBe(50 * MINUTE);
    expect(pace?.remainingMs).toBe((50 * MINUTE * (346 - 60)) / 48);
  });

  it("estimates nothing until it has watched long enough and seen enough tests settle", () => {
    expect(runPace(run({}), NOW)).toBeNull();
    watch(9, 60);
    expect(runPace(run({}), NOW)).toBeNull();
    observeRunPace(run({ state: "paused" }), NOW);
    watch(30, 73);
    expect(runPace(run({}), NOW)).toBeNull();
    watch(1, 76);
    expect(runPace(run({ settledCellCount: 76 }), NOW)).not.toBeNull();
  });

  it("starts over once the run has stood, and for a count that went back", () => {
    watch(30, 60);
    watch(20, 75, { state: "paused" });
    watch(12, 75);
    expect(runPace(run({ settledCellCount: 90 }), NOW)?.watchedMs).toBe(
      12 * MINUTE,
    );
    // Another plan: fewer tests settled than before.
    watch(11, 5);
    expect(runPace(run({ settledCellCount: 20 }), NOW)?.watchedMs).toBe(
      11 * MINUTE,
    );
  });

  it("estimates nothing for a run that stands or has nothing left", () => {
    watch(30, 60);
    expect(runPace(run({ state: "pausing" }), NOW)).toBeNull();
    expect(runPace(run({ settledCellCount: 346 }), NOW)).toBeNull();
  });

  it("says a run would outlast its window only with enough tests behind the pace", () => {
    watch(30, 70);
    const early = runPace(run({}), NOW);
    // Five tests in half an hour: twenty-seven hours for the rest, shown
    // but not yet believed.
    expect(early?.remainingMs).toBe((30 * MINUTE * 271) / 5);
    expect(early?.pastWindow).toBe(false);
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
