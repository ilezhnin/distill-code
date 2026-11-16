import { describe, expect, it } from "vitest";
import { attempt, configuration } from "../__tests__/fixtures";
import type { Attempt, Evaluation } from "../types";
import {
  attemptTrail,
  countedRepetitions,
  earlierTries,
  reasonWords,
  supersededOutcome,
  type TrailContext,
  type TrailStep,
} from "./benchmarkAttemptTrail";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

/** Keys stand for their words, with the time a label was given. */
const t = (key: string, options?: Record<string, unknown>) =>
  options?.time ? `${key}@${options.time}` : key;

const context: TrailContext = {
  judged: false,
  runState: "running",
  timeoutSeconds: 5400,
  now: NOW,
  formatTime: (at) => `t${(at - NOW) / MINUTE}`,
};

const open: Attempt = {
  ...attempt,
  phase: "pending",
  outcome: null,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  output: null,
  evaluations: [],
};

function trail(shown: Attempt, changes: Partial<TrailContext> = {}) {
  return attemptTrail(t, shown, { ...context, ...changes });
}

function step(steps: TrailStep[], id: string): TrailStep {
  const found = steps.find((entry) => entry.id === id);
  if (!found) throw new Error(`no ${id} step`);
  return found;
}

const states = (steps: TrailStep[]) =>
  Object.fromEntries(steps.map((entry) => [entry.id, entry.state]));

function vote(
  id: string,
  judge: string,
  changes: Partial<Evaluation>,
): Evaluation {
  return {
    id,
    evaluatorRevision: "1",
    verdict: "judged",
    score: null,
    reason: "",
    createdAt: NOW,
    provenance: "judge",
    artifacts: [],
    judge: { ...configuration, id: judge, modelId: judge },
    ...changes,
  };
}

describe("an attempt's trail", () => {
  it("puts a running test between what is behind it and what is ahead", () => {
    const steps = trail({
      ...open,
      phase: "running",
      sessionId: "session",
      startedAt: NOW - 17 * MINUTE,
      phaseTimes: {
        sessionOpened: NOW - 17 * MINUTE + 6000,
        dispatched: NOW - 17 * MINUTE + 6500,
      },
      activity: {
        recordedFrom: 0,
        spans: [
          {
            kind: "waiting",
            startedAt: NOW - 30 * MINUTE,
            finishedAt: NOW - 17 * MINUTE,
          },
          { kind: "execution", startedAt: NOW - 17 * MINUTE, finishedAt: null },
        ],
      },
    });
    // An objective test has no panel to wait for.
    expect(states(steps)).toEqual({
      queue: "done",
      prepare: "done",
      work: "running",
      check: "pending",
      result: "pending",
    });
    expect(step(steps, "queue").durationMs).toBe(13 * MINUTE);
    expect(step(steps, "prepare").durationMs).toBe(6000);
    expect(step(steps, "work")).toMatchObject({
      status: "states.running",
      since: NOW - 17 * MINUTE + 6500,
      limitMs: 5400_000,
    });
  });

  it("says what a queued test waits for, in words that carry no account", () => {
    const quota = trail({
      ...open,
      reason:
        '{"code":-32603,"data":{"accountId":"private-account"},"message":"Internal error: Usage limit reached for 5 hour."}',
      waitUntil: NOW + 42 * MINUTE,
      activity: {
        recordedFrom: 0,
        spans: [
          { kind: "waiting", startedAt: NOW - 61 * MINUTE, finishedAt: null },
        ],
      },
    });
    const queue = step(quota, "queue");
    expect(queue).toMatchObject({
      state: "waiting",
      status: "modelRun.waitingQuotaUntil@t42",
      since: NOW - 61 * MINUTE,
    });
    // The label names the time, so no line repeats it.
    expect(queue.substeps).toEqual([
      {
        id: "reason",
        title: "Usage limit reached for 5 hour.",
        state: "waiting",
      },
    ]);
    expect(JSON.stringify(quota)).not.toContain("private-account");

    const room = step(
      trail({
        ...open,
        reason:
          "Waiting for local resources: resource_busy: the measured host CPU load (71%) is at or above the 70% line",
        waitUntil: NOW + MINUTE,
      }),
      "queue",
    );
    expect(room.status).toBe("modelRun.waitingResources@t1");
    expect(room.substeps).toEqual([
      {
        id: "reason",
        title: "The measured host CPU load (71%) is at or above the 70% line",
        state: "waiting",
      },
      { id: "until", title: "trail.nextTry", detail: "t1", state: "pending" },
    ]);
    // A test nothing holds back is simply queued.
    expect(step(trail(open), "queue")).toMatchObject({
      state: "waiting",
      status: "modelRun.queued",
      substeps: [],
    });
  });

  it("seats a panel: who voted, who is asked, who is still to come", () => {
    const panel = ["alpha", "beta", "gamma"].map((id) => ({
      ...configuration,
      id,
      modelId: id,
    }));
    const steps = trail(
      {
        ...open,
        phase: "awaiting_judges",
        outcome: "pending_review",
        startedAt: NOW - 9 * MINUTE,
        output: "answer",
        phaseTimes: {
          dispatched: NOW - 9 * MINUTE,
          collected: NOW - 8 * MINUTE,
          judgeStarted: NOW - 3 * MINUTE,
        },
        evaluations: [
          vote("marker", "none", {
            provenance: "render",
            verdict: "rendered",
            judge: null,
            details: { expectedJudges: 3, protocol: { panel } },
          }),
          vote("first", "alpha", { score: 0.875 }),
          vote("second", "beta", {
            provenance: "judge_failure",
            verdict: "abstained",
            details: { inFlight: true },
          }),
        ],
      },
      { judged: true },
    );
    expect(states(steps)).toEqual({
      queue: "done",
      prepare: "done",
      work: "done",
      check: "done",
      judges: "running",
      result: "pending",
    });
    // A panel task collects an answer; it checks nothing itself.
    expect(step(steps, "check").title).toBe("trail.collect");
    expect(step(steps, "judges")).toMatchObject({
      status: "trail.judging",
      since: NOW - 3 * MINUTE,
      count: "1/3",
      substeps: [
        { id: "alpha", title: "alpha", detail: "0.88", state: "done" },
        { id: "beta", title: "beta", state: "running" },
        { id: "gamma", title: "gamma", state: "pending" },
      ],
    });
  });

  it("names why no judge is asked yet", () => {
    const judges = step(
      trail(
        {
          ...open,
          phase: "awaiting_judges",
          outcome: "pending_review",
          reason: "Waiting for local resources to judge: no room",
          activity: {
            recordedFrom: 0,
            spans: [
              { kind: "waiting", startedAt: NOW - MINUTE, finishedAt: null },
            ],
          },
        },
        { judged: true },
      ),
      "judges",
    );
    expect(judges).toMatchObject({
      state: "waiting",
      status: "modelRun.waitingJudges",
      since: NOW - MINUTE,
      substeps: [{ id: "reason", title: "No room", state: "waiting" }],
    });
  });

  it("marks the step a settled attempt ended in and leaves the rest out", () => {
    const steps = trail({
      ...attempt,
      outcome: "infrastructure_failure",
      reason:
        '{"code":-32603,"data":{"accountId":"private-account"},"message":"The agent\'s bridge exited before this turn finished"}',
      sessionId: "session",
      durationMs: 14 * MINUTE,
      // The runner stamps the collection even on a turn that died.
      phaseTimes: { dispatched: 1500, collected: 2000 },
      evaluations: [],
    });
    expect(states(steps)).toEqual({
      queue: "done",
      prepare: "done",
      work: "failed",
      check: "skipped",
      result: "failed",
    });
    expect(step(steps, "work")).toMatchObject({
      durationMs: 14 * MINUTE,
      substeps: [
        {
          id: "reason",
          title: "The agent's bridge exited before this turn finished",
          state: "failed",
        },
      ],
    });
    expect(step(steps, "result").status).toBe("states.infrastructure_failure");
    expect(JSON.stringify(steps)).not.toContain("private-account");
  });

  it("shows a failed check with what the check said", () => {
    const steps = trail({
      ...attempt,
      outcome: "fail",
      evaluations: [
        {
          ...attempt.evaluations[0],
          verdict: "fail",
          score: 0,
          reason: "3 of 14 checks failed",
        },
      ],
    });
    expect(states(steps)).toMatchObject({
      work: "done",
      check: "failed",
      result: "failed",
    });
    expect(step(steps, "check").substeps).toEqual([
      {
        id: "eval-1",
        title: "3 of 14 checks failed",
        detail: "states.fail",
        state: "failed",
      },
    ]);
    // A test that passed went through every step.
    expect(new Set(Object.values(states(trail(attempt))))).toEqual(
      new Set(["done"]),
    );
  });

  it("holds an open attempt of a run that stopped, with no clock", () => {
    const work = step(
      trail(
        {
          ...open,
          phase: "running",
          startedAt: NOW - MINUTE,
          phaseTimes: { dispatched: NOW - MINUTE },
        },
        { runState: "needs_attention" },
      ),
      "work",
    );
    expect(work).toMatchObject({
      state: "waiting",
      status: "states.needs_attention",
      since: null,
      limitMs: null,
    });
  });

  it("keeps what a finished answer still waits for on its result", () => {
    const reason =
      "Critical checks unresolved: invented check still lacks evidence.";
    const result = step(
      trail({ ...attempt, outcome: "pending_review", evaluations: [], reason }),
      "result",
    );
    expect(result).toMatchObject({
      state: "waiting",
      status: "states.pending_review",
      substeps: [{ id: "reason", title: reason, state: "waiting" }],
    });
  });
});

describe("tries the run measured again", () => {
  const tried = (
    id: string,
    startedAt: number | null,
    was: string,
  ): Attempt => ({
    ...attempt,
    id,
    repetition: -(startedAt ?? 1),
    outcome: "superseded",
    reason: `Measured again on resume: 0 of 3 repetitions were measured when the run stopped (this one: ${was})`,
    startedAt,
    sessionId: startedAt == null ? null : "session",
  });
  const second: Attempt = { ...attempt, id: "attempt-2", repetition: 1 };
  const attempts = [
    tried("old", 100, "infrastructure_failure"),
    second,
    tried("older", 50, "quota_blocked"),
    tried("unstarted", null, "cancelled"),
    attempt,
    { ...attempt, id: "other-case", versionId: "version-2" },
  ];

  it("are no repetitions, and are listed newest first", () => {
    expect(
      countedRepetitions(attempts, attempt).map((entry) => entry.id),
    ).toEqual(["attempt-1", "attempt-2"]);
    // A try that never started left nothing to look at.
    expect(earlierTries(attempts, attempt).map((entry) => entry.id)).toEqual([
      "old",
      "older",
    ]);
    // An opened earlier try stands among the repetitions it is shown with.
    expect(
      countedRepetitions(attempts, attempts[0]).map((entry) => entry.id),
    ).toEqual(["old", "attempt-1", "attempt-2"]);
  });

  it("keep the outcome they had come to", () => {
    expect(supersededOutcome(attempts[0])).toBe("infrastructure_failure");
    expect(supersededOutcome(attempt)).toBe("pass");
    const steps = trail({ ...attempts[0], phaseTimes: { dispatched: 120 } });
    expect(step(steps, "work").state).toBe("failed");
    expect(step(steps, "result")).toMatchObject({
      state: "failed",
      status: "states.superseded",
      substeps: [{ id: "outcome", title: "states.infrastructure_failure" }],
    });
  });
});

describe("a recorded reason as words", () => {
  it("reads a host error by its message and a wait without its prefix", () => {
    expect(
      reasonWords(
        '{"data":{"accountId":"a"},"message":"Internal error: Rate limit reached"}',
      ),
    ).toBe("Rate limit reached");
    expect(
      reasonWords("Waiting for local resources: resource_busy: no room"),
    ).toBe("No room");
    expect(reasonWords("{not json")).toBe("{not json");
  });
});
