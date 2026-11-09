import { beforeEach, describe, expect, it, vi } from "vitest";

import { CommandError } from "@/features/flockctl/commands/types";

const loadSessionForFlockctl = vi.hoisted(() => vi.fn(async () => ({})));
const requireSession = vi.hoisted(() => vi.fn());

vi.mock("@/features/flockctl/commands/runtime/sessions", () => ({
  loadSessionForFlockctl,
  requireSession,
}));

const { dispatchCommand } = await import(
  "@/features/flockctl/commands/registry"
);
const { getMonitorJobs, resetMonitorJobStoreForTests } = await import(
  "@/features/conductor/monitorJobStore"
);

const STARTED_AT = 1_762_600_000;

function report(args: Record<string, unknown> = {}) {
  return dispatchCommand(
    "jobs",
    {
      action: "report",
      session_id: "worker-1",
      job_id: "4242-1762600000",
      state_key: "build",
      label: "nightly build",
      state: "running",
      monitor_pid: 4242,
      producer_pid: 4250,
      started_at: STARTED_AT,
      ...args,
    },
    {},
  );
}

beforeEach(() => {
  resetMonitorJobStoreForTests();
  loadSessionForFlockctl.mockClear();
  requireSession.mockReset();
});

describe("flockctl job report", () => {
  it("records a job in the app's units and checks its owner once", async () => {
    await expect(report()).resolves.toEqual({
      job_id: "4242-1762600000",
      state: "running",
    });
    await report({ last_output_at: STARTED_AT + 90, silence_minutes: 30 });
    expect(requireSession).toHaveBeenCalledTimes(1);
    expect(getMonitorJobs()["4242-1762600000"]).toMatchObject({
      ownerSessionId: "worker-1",
      startedAt: STARTED_AT * 1000,
      lastOutputAt: (STARTED_AT + 90) * 1000,
      silenceMinutes: 30,
      producerPid: 4250,
      state: "running",
    });
  });

  it("ends a job with its exit code, and a later report keeps it ended", async () => {
    await report();
    await expect(
      report({ state: "exited", exit_code: 3, detail: "exit code: 3" }),
    ).resolves.toEqual({ job_id: "4242-1762600000", state: "exited" });
    await expect(report()).resolves.toEqual({
      job_id: "4242-1762600000",
      state: "exited",
    });
    expect(getMonitorJobs()["4242-1762600000"]?.exitCode).toBe(3);
  });

  it("refuses a job whose owner is not a session", async () => {
    requireSession.mockImplementation(() => {
      throw new CommandError("session_not_found", 'No session "worker-1"');
    });
    await expect(report()).rejects.toMatchObject({ code: "session_not_found" });
    expect(getMonitorJobs()).toEqual({});
  });

  it("refuses fields the monitor could not have sent", async () => {
    await expect(report({ label: "two\nlines" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    await expect(report({ job_id: "has space" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    await expect(report({ silence_minutes: 1441 })).rejects.toMatchObject({
      code: "invalid_args",
    });
    await expect(report({ state: "lost" })).rejects.toMatchObject({
      code: "invalid_args",
    });
  });
});

describe("flockctl job list", () => {
  it("lists running jobs, and ended ones on request", async () => {
    await report();
    await report({
      job_id: "4243-1762600100",
      state_key: "tests",
      started_at: STARTED_AT + 100,
    });
    await report({
      job_id: "4243-1762600100",
      state_key: "tests",
      state: "stopped",
    });
    const running = (await dispatchCommand(
      "jobs",
      { action: "list", session_id: "worker-1" },
      {},
    )) as { jobs: Array<Record<string, unknown>> };
    expect(running.jobs.map((job) => job.job_id)).toEqual(["4242-1762600000"]);
    expect(running.jobs[0]).toMatchObject({
      session_id: "worker-1",
      state: "running",
      started_at: new Date(STARTED_AT * 1000).toISOString(),
      last_output_at: null,
      silence_minutes: 15,
    });
    const all = (await dispatchCommand(
      "jobs",
      { action: "list", include_ended: true },
      {},
    )) as { jobs: Array<Record<string, unknown>> };
    expect(all.jobs.map((job) => job.state)).toEqual(["running", "stopped"]);
    const other = (await dispatchCommand(
      "jobs",
      { action: "list", session_id: "someone-else" },
      {},
    )) as { jobs: unknown[] };
    expect(other.jobs).toEqual([]);
  });
});
