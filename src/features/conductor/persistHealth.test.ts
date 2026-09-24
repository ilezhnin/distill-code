import { afterEach, describe, expect, it } from "vitest";

import {
  getPersistHealth,
  isPersistHealthy,
  notePersistFailure,
  notePersistReadOutage,
  persistReadOutageScopes,
  resetPersistHealthForTests,
  subscribePersistHealth,
  takeUnreportedPersistFailure,
  totalPersistFailures,
} from "./persistHealth";

afterEach(() => {
  resetPersistHealthForTests();
});

describe("persistHealth", () => {
  it("counts refusals per store and keeps the first timestamp", () => {
    notePersistFailure("waves");
    notePersistFailure("waves");
    notePersistFailure("graph");
    const health = getPersistHealth();
    expect(health.failuresByScope).toEqual({
      graph: 1,
      waves: 2,
      telemetry: 0,
      "run-journal": 0,
    });
    expect(totalPersistFailures()).toBe(3);
    expect(health.firstFailureAt).not.toBeNull();
    expect(health.lastFailureAt).toBeGreaterThanOrEqual(
      health.firstFailureAt as number,
    );
  });

  it("hands the report out exactly once", () => {
    // A full origin refuses every write. Reporting per failure would bury the
    // transcript under the same warning hundreds of times.
    notePersistFailure("waves");
    expect(takeUnreportedPersistFailure()).not.toBeNull();
    expect(takeUnreportedPersistFailure()).toBeNull();
    notePersistFailure("waves");
    expect(takeUnreportedPersistFailure()).toBeNull();
  });

  it("records a read outage separately from a refused write", () => {
    // A read that gave up is the louder failure: the store never hydrates, so
    // the wave engine sits out the whole session. It must not be counted as a
    // refused write, whose notice waits for a live wave that will never exist.
    notePersistReadOutage("waves", new Error("EPERM"));

    expect(persistReadOutageScopes()).toEqual(["waves"]);
    expect(isPersistHealthy()).toBe(false);
    expect(totalPersistFailures()).toBe(0);
    expect(takeUnreportedPersistFailure()).toBeNull();
    expect(getPersistHealth().firstFailureAt).not.toBeNull();

    // Recorded once, however many times the tick asks.
    notePersistReadOutage("waves");
    expect(persistReadOutageScopes()).toEqual(["waves"]);
  });

  it("does not let a throwing subscriber reach the store's write path", () => {
    // This runs inside a store's `catch`. If it could throw, a quota error
    // would become a crash in the middle of a wave — the exact outcome the
    // swallowed write exists to prevent.
    subscribePersistHealth(() => {
      throw new Error("reader exploded");
    });
    expect(() => notePersistFailure("waves")).not.toThrow();
    expect(totalPersistFailures()).toBe(1);
  });
});
