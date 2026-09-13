import { afterEach, describe, expect, it } from "vitest";

import {
  clearPersistReadOutage,
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
  it("starts healthy and says nothing", () => {
    expect(isPersistHealthy()).toBe(true);
    expect(takeUnreportedPersistFailure()).toBeNull();
    expect(getPersistHealth().firstFailureAt).toBeNull();
  });

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

  it("keeps the browser's own name for the failure", () => {
    const quota = new Error("exceeded");
    quota.name = "QuotaExceededError";
    notePersistFailure("waves", quota);
    expect(getPersistHealth().reason).toBe("QuotaExceededError");
  });

  it("keeps the first reason, not the latest", () => {
    // The first refusal is the one that explains the condition; every later
    // one is the same condition repeating.
    const first = new Error("x");
    first.name = "QuotaExceededError";
    notePersistFailure("waves", first);
    const second = new Error("y");
    second.name = "SecurityError";
    notePersistFailure("graph", second);
    expect(getPersistHealth().reason).toBe("QuotaExceededError");
  });

  it("survives an error that is not an Error", () => {
    expect(() => notePersistFailure("telemetry", "nope")).not.toThrow();
    expect(getPersistHealth().reason).toBeUndefined();
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

  it("notifies subscribers on every refusal", () => {
    let seen = 0;
    const stop = subscribePersistHealth(() => {
      seen += 1;
    });
    notePersistFailure("waves");
    notePersistFailure("graph");
    expect(seen).toBe(2);
    stop();
    notePersistFailure("waves");
    expect(seen).toBe(2);
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

  it("clears a read outage once the document is finally read", () => {
    notePersistReadOutage("graph");
    let seen = 0;
    subscribePersistHealth(() => {
      seen += 1;
    });

    clearPersistReadOutage("graph");

    expect(persistReadOutageScopes()).toEqual([]);
    expect(isPersistHealthy()).toBe(true);
    expect(seen).toBe(1);
    // Clearing an outage that is not recorded is a no-op, not a notification.
    clearPersistReadOutage("graph");
    expect(seen).toBe(1);
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
