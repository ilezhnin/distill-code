import { describe, expect, it } from "vitest";

import { computeProcessStartedAt } from "./processClock";

describe("computeProcessStartedAt", () => {
  const startWall = 1_700_000_000_000;
  const startMonotonic = 500;

  it("is the wall-clock capture while the clock behaves", () => {
    expect(
      computeProcessStartedAt({
        startWall,
        startMonotonic,
        nowWall: startWall + 30_000,
        nowMonotonic: startMonotonic + 30_000,
      }),
    ).toBe(startWall);
  });

  it("moves back with a clock set backwards mid-session", () => {
    // The clock was a day fast at launch and resynced while the app was up.
    // A plan made now is stamped a day behind the captured start, so the start
    // has to follow the correction or the watermark would disown messages this
    // very process produced.
    const jump = 86_400_000;
    expect(
      computeProcessStartedAt({
        startWall,
        startMonotonic,
        nowWall: startWall + 30_000 - jump,
        nowMonotonic: startMonotonic + 30_000,
      }),
    ).toBe(startWall - jump);
  });

  it("ignores a clock set forwards", () => {
    // Messages produced between launch and the jump are genuinely this
    // process's, so the start must not run ahead of them.
    expect(
      computeProcessStartedAt({
        startWall,
        startMonotonic,
        nowWall: startWall + 30_000 + 86_400_000,
        nowMonotonic: startMonotonic + 30_000,
      }),
    ).toBe(startWall);
  });

  it("treats a monotonic clock that went backwards as no elapsed time", () => {
    // Not expected from performance.now(), but a negative elapsed would read as
    // forward wall drift and is clamped away rather than trusted.
    expect(
      computeProcessStartedAt({
        startWall,
        startMonotonic,
        nowWall: startWall,
        nowMonotonic: startMonotonic - 10_000,
      }),
    ).toBe(startWall);
  });
});
