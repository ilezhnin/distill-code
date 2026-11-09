import { beforeEach, describe, expect, it, vi } from "vitest";

const deliverEnvelope = vi.hoisted(() =>
  vi.fn(async () => ({ status: "dispatched" as const })),
);
const loadSessionForFlockctl = vi.hoisted(() => vi.fn(async () => ({})));
const requireSession = vi.hoisted(() => vi.fn());

vi.mock("./digestDelivery", () => ({ deliverEnvelope }));
vi.mock("@/features/flockctl/commands/runtime/sessions", () => ({
  loadSessionForFlockctl,
  requireSession,
}));

const { applyMonitorJobReport, DEFAULT_MONITOR_SILENCE_MINUTES } = await import(
  "./monitorJobs"
);
const { getMonitorJobs, recordMonitorJobReport, resetMonitorJobStoreForTests } =
  await import("./monitorJobStore");
const { checkMonitorJobProcesses, noticeSilentMonitorJobs } = await import(
  "./monitorJobWatch"
);

const MINUTE = 60_000;
const THRESHOLD = DEFAULT_MONITOR_SILENCE_MINUTES * MINUTE;

function running(jobId: string, startedAt: number, reportedAt: number) {
  return applyMonitorJobReport(
    {},
    {
      jobId,
      ownerSessionId: "worker-1",
      stateKey: jobId,
      label: `job ${jobId}`,
      state: "running",
      monitorPid: 100,
      producerPid: 101,
      startedAt,
    },
    reportedAt,
  ).job;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  deliverEnvelope.mockClear();
  loadSessionForFlockctl.mockClear();
  requireSession.mockReset();
  resetMonitorJobStoreForTests();
});

describe("checkMonitorJobProcesses", () => {
  it("marks a job whose monitor is gone as lost and keeps the live one", async () => {
    const now = Date.now();
    resetMonitorJobStoreForTests({
      gone: running("gone", now - 10 * MINUTE, now - 5 * MINUTE),
      alive: running("alive", now - 10 * MINUTE, now - 5 * MINUTE),
    });
    const probe = vi.fn(async (probes: readonly { pid: number }[]) =>
      probes.map((_, index) => index === 1),
    );
    await checkMonitorJobProcesses(probe);
    expect(probe).toHaveBeenCalledWith([
      { pid: 100, startedBySecs: Math.floor((now - 10 * MINUTE) / 1000) },
      { pid: 100, startedBySecs: Math.floor((now - 10 * MINUTE) / 1000) },
    ]);
    expect(getMonitorJobs().gone?.state).toBe("lost");
    expect(getMonitorJobs().alive?.state).toBe("running");
  });

  it("leaves a job that reported during the check alone", async () => {
    const now = Date.now();
    resetMonitorJobStoreForTests({
      job: running("job", now - 10 * MINUTE, now - 5 * MINUTE),
    });
    await checkMonitorJobProcesses(async () => {
      recordMonitorJobReport(
        {
          jobId: "job",
          ownerSessionId: "worker-1",
          stateKey: "job",
          label: "job job",
          state: "running",
          monitorPid: 100,
          startedAt: now - 10 * MINUTE,
        },
        now + MINUTE,
      );
      return [false];
    });
    expect(getMonitorJobs().job?.state).toBe("running");
  });

  it("keeps every job when the check cannot answer", async () => {
    const now = Date.now();
    resetMonitorJobStoreForTests({ job: running("job", now, now) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await checkMonitorJobProcesses(async () => {
      throw new Error("no system");
    });
    expect(getMonitorJobs().job?.state).toBe("running");
    warn.mockRestore();
  });
});

describe("noticeSilentMonitorJobs", () => {
  it("tells the owner once per silence", async () => {
    const now = Date.now();
    resetMonitorJobStoreForTests({
      job: running("job", now - THRESHOLD - MINUTE, now),
    });
    noticeSilentMonitorJobs(now);
    // A second pass before the first delivery settles says nothing more.
    noticeSilentMonitorJobs(now);
    await settle();
    noticeSilentMonitorJobs(now + MINUTE);
    await settle();
    expect(deliverEnvelope).toHaveBeenCalledTimes(1);
    const [owner, text] = deliverEnvelope.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(owner).toBe("worker-1");
    expect(text).toContain("[monitor: job job] No output for");
    expect(getMonitorJobs().job?.silenceNotice).toMatchObject({
      status: "dispatched",
      quietSince: now - THRESHOLD - MINUTE,
    });
  });

  it("says nothing about a job that printed recently", async () => {
    const now = Date.now();
    resetMonitorJobStoreForTests({ job: running("job", now - MINUTE, now) });
    noticeSilentMonitorJobs(now);
    await settle();
    expect(deliverEnvelope).not.toHaveBeenCalled();
  });

  it("records a notice for an owner the app does not know as failed", async () => {
    const now = Date.now();
    requireSession.mockImplementation(() => {
      throw new Error('No session "worker-1"');
    });
    resetMonitorJobStoreForTests({
      job: running("job", now - THRESHOLD - MINUTE, now),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    noticeSilentMonitorJobs(now);
    await settle();
    expect(deliverEnvelope).not.toHaveBeenCalled();
    expect(getMonitorJobs().job?.silenceNotice?.status).toBe("failed");
    // Failed is still said: the next pass does not try again for this silence.
    noticeSilentMonitorJobs(now + MINUTE);
    await settle();
    expect(deliverEnvelope).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
