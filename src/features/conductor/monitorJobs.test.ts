import { describe, expect, it } from "vitest";

import {
  applyMonitorJobReport,
  DEFAULT_MONITOR_SILENCE_MINUTES,
  isMonitorJobSilenceDue,
  liveMonitorJobCount,
  liveMonitorJobOwnerIds,
  MAX_MONITOR_JOBS,
  markLostMonitorJobs,
  type MonitorJob,
  type MonitorJobReport,
  MONITOR_JOB_RETENTION_MS,
  monitorSilenceNoticeText,
  parseStoredMonitorJob,
  pruneMonitorJobs,
} from "./monitorJobs";

const MINUTE = 60_000;
const T0 = 1_762_600_000_000;

function report(overrides: Partial<MonitorJobReport> = {}): MonitorJobReport {
  return {
    jobId: "job-1",
    ownerSessionId: "worker-1",
    stateKey: "build",
    label: "nightly build",
    state: "running",
    monitorPid: 4242,
    producerPid: 4250,
    startedAt: T0,
    ...overrides,
  };
}

function recorded(
  reports: Array<[MonitorJobReport, number]>,
  start: Record<string, MonitorJob> = {},
): Record<string, MonitorJob> {
  let jobsById = start;
  for (const [entry, at] of reports) {
    jobsById = applyMonitorJobReport(jobsById, entry, at).jobsById;
  }
  return jobsById;
}

describe("applyMonitorJobReport", () => {
  it("records a started job as running and keeps its last output", () => {
    const jobs = recorded([
      [report(), T0 + 1_000],
      [report({ lastOutputAt: T0 + 30_000 }), T0 + MINUTE],
      // A heartbeat never moves the last output backwards.
      [report({ lastOutputAt: T0 + 10_000 }), T0 + 2 * MINUTE],
    ]);
    expect(jobs["job-1"]).toMatchObject({
      state: "running",
      lastOutputAt: T0 + 30_000,
      lastReportAt: T0 + 2 * MINUTE,
      startedAt: T0,
    });
    expect(liveMonitorJobOwnerIds(jobs)).toEqual(new Set(["worker-1"]));
    expect(liveMonitorJobCount(jobs, ["other", "worker-1"])).toBe(1);
  });

  it("ends a job once and ignores what comes after", () => {
    const jobs = recorded([
      [report(), T0],
      [
        report({ state: "exited", exitCode: 2, detail: "exit code: 2" }),
        T0 + MINUTE,
      ],
      [report(), T0 + 2 * MINUTE],
      [report({ state: "exited", exitCode: 0 }), T0 + 3 * MINUTE],
    ]);
    expect(jobs["job-1"]).toMatchObject({
      state: "exited",
      exitCode: 2,
      detail: "exit code: 2",
      endedAt: T0 + MINUTE,
    });
    expect(liveMonitorJobCount(jobs, ["worker-1"])).toBe(0);
  });

  it("brings a lost job back when its monitor reports again", () => {
    const lost = markLostMonitorJobs(
      recorded([[report(), T0]]),
      new Map([["job-1", false]]),
      T0 + MINUTE,
    );
    expect(lost?.["job-1"]?.state).toBe("lost");
    const revived = recorded([[report(), T0 + 2 * MINUTE]], lost ?? {});
    expect(revived["job-1"]?.state).toBe("running");
    expect(revived["job-1"]?.endedAt).toBeUndefined();
  });

  it("ends an older run of the same state key when a new one starts", () => {
    const jobs = recorded([
      [report(), T0],
      [report({ jobId: "job-2", startedAt: T0 + 5 * MINUTE }), T0 + 5 * MINUTE],
    ]);
    expect(jobs["job-1"]?.state).toBe("lost");
    expect(jobs["job-2"]?.state).toBe("running");
  });
});

describe("markLostMonitorJobs", () => {
  it("marks only the jobs whose monitor is known to be gone", () => {
    const jobs = recorded([
      [report(), T0],
      [report({ jobId: "job-2", stateKey: "tests" }), T0],
      [report({ jobId: "job-3", stateKey: "scrape" }), T0],
    ]);
    const next = markLostMonitorJobs(
      jobs,
      new Map([
        ["job-1", false],
        ["job-2", true],
      ]),
      T0 + MINUTE,
    );
    expect(next?.["job-1"]?.state).toBe("lost");
    expect(next?.["job-2"]?.state).toBe("running");
    // No answer is not "gone".
    expect(next?.["job-3"]?.state).toBe("running");
    expect(markLostMonitorJobs(jobs, new Map(), T0)).toBeNull();
  });
});

describe("isMonitorJobSilenceDue", () => {
  const threshold = DEFAULT_MONITOR_SILENCE_MINUTES * MINUTE;

  it("judges silence from the monitor's report, not from the clock", () => {
    const quiet = recorded([
      [report({ lastOutputAt: T0 }), T0 + threshold - MINUTE],
    ])["job-1"] as MonitorJob;
    expect(isMonitorJobSilenceDue(quiet)).toBe(false);
    const silent = recorded([[report({ lastOutputAt: T0 }), T0 + threshold]])[
      "job-1"
    ] as MonitorJob;
    expect(isMonitorJobSilenceDue(silent)).toBe(true);
  });

  it("says one silence once and a new one after the job prints again", () => {
    const silent = recorded([[report({ lastOutputAt: T0 }), T0 + threshold]])[
      "job-1"
    ] as MonitorJob;
    const told: MonitorJob = {
      ...silent,
      silenceNotice: { quietSince: T0, at: T0 + threshold, status: "queued" },
    };
    expect(isMonitorJobSilenceDue(told)).toBe(false);
    const printedAgain = recorded(
      [
        [
          report({ lastOutputAt: T0 + threshold + MINUTE }),
          T0 + 2 * threshold + MINUTE,
        ],
      ],
      { "job-1": told },
    )["job-1"] as MonitorJob;
    expect(printedAgain.silenceNotice?.quietSince).toBe(T0);
    expect(isMonitorJobSilenceDue(printedAgain)).toBe(true);
  });

  it("follows a job's own threshold, and never for 0", () => {
    const short = recorded([
      [report({ silenceMinutes: 2, lastOutputAt: T0 }), T0 + 2 * MINUTE],
    ])["job-1"] as MonitorJob;
    expect(isMonitorJobSilenceDue(short)).toBe(true);
    const never = recorded([
      [report({ silenceMinutes: 0 }), T0 + 10 * threshold],
    ])["job-1"] as MonitorJob;
    expect(isMonitorJobSilenceDue(never)).toBe(false);
  });

  it("counts a job that printed nothing as silent since its start", () => {
    const job = recorded([[report(), T0 + threshold]])["job-1"] as MonitorJob;
    expect(isMonitorJobSilenceDue(job)).toBe(true);
  });

  it("never calls an ended job silent", () => {
    const job = recorded([[report({ state: "stopped" }), T0 + 10 * threshold]])[
      "job-1"
    ] as MonitorJob;
    expect(isMonitorJobSilenceDue(job)).toBe(false);
  });
});

describe("monitorSilenceNoticeText", () => {
  it("names the job, the silence and the command that stops it", () => {
    const job = recorded([
      [
        report({
          stateKey: "re scrape",
          lastOutputAt: T0 + 5 * MINUTE,
          logPath: "C:/state/watcher.log",
        }),
        T0 + 25 * MINUTE,
      ],
    ])["job-1"] as MonitorJob;
    const text = monitorSilenceNoticeText(job, T0 + 25 * MINUTE);
    expect(text).toContain("[monitor: nightly build] No output for 20 minutes");
    expect(text).toContain("pid 4250");
    expect(text).toContain("C:/state/watcher.log");
    expect(text).toContain(
      'flock-monitor stop --session-id worker-1 --state-key "re scrape"',
    );
    expect(text).toContain("once per silence");
  });
});

describe("pruneMonitorJobs", () => {
  it("drops ended jobs past their retention and keeps running ones", () => {
    const jobs = recorded([
      [report({ jobId: "old", stateKey: "a", state: "exited" }), T0],
      [report({ jobId: "live", stateKey: "b" }), T0],
    ]);
    const pruned = pruneMonitorJobs(jobs, T0 + MONITOR_JOB_RETENTION_MS + 1);
    expect(Object.keys(pruned)).toEqual(["live"]);
  });

  it("caps the record, dropping ended jobs before running ones", () => {
    let jobs: Record<string, MonitorJob> = {};
    for (let index = 0; index < MAX_MONITOR_JOBS + 5; index += 1) {
      jobs = applyMonitorJobReport(
        jobs,
        report({
          jobId: `job-${index}`,
          stateKey: `key-${index}`,
          state: index < 10 ? "running" : "exited",
        }),
        T0 + index,
      ).jobsById;
    }
    expect(Object.keys(jobs)).toHaveLength(MAX_MONITOR_JOBS);
    for (let index = 0; index < 10; index += 1) {
      expect(jobs[`job-${index}`]?.state).toBe("running");
    }
  });
});

describe("parseStoredMonitorJob", () => {
  it("reads back what it stored and refuses what is not a job", () => {
    const job = recorded([[report({ lastOutputAt: T0 + 1 }), T0 + 2]])[
      "job-1"
    ] as MonitorJob;
    const stored = JSON.parse(
      JSON.stringify({
        ...job,
        silenceNotice: { quietSince: T0, at: T0 + 2, status: "dispatched" },
      }),
    );
    expect(parseStoredMonitorJob(stored)).toEqual({
      ...job,
      silenceNotice: { quietSince: T0, at: T0 + 2, status: "dispatched" },
    });
    expect(parseStoredMonitorJob({ ...stored, state: "dreaming" })).toBeNull();
    expect(parseStoredMonitorJob({ ...stored, monitorPid: "4242" })).toBeNull();
    expect(parseStoredMonitorJob(null)).toBeNull();
  });
});
