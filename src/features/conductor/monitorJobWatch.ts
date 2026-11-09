/**
 * Keeps the `flock-monitor` job record honest, and tells an owner when its
 * job goes quiet.
 *
 * Two duties, both on a slow clock:
 *
 * - **A job whose process is gone must not stay running.** The monitor
 *   reports its own end, but a monitor that was killed, or that ended while
 *   the app was closed, cannot. Each pass asks the system whether every
 *   running job's monitor still runs (by id and start time, so a later
 *   process given the same id is not taken for it) and marks the ones that do
 *   not as lost. The first pass runs as soon as the record is read, so a
 *   restart does not show a dead job as working for a minute.
 * - **A silence is said once.** A producer that hangs while alive sends
 *   nothing, and before this nobody was ever told. When a job's latest report
 *   says it has printed nothing for its threshold, its owner gets one message
 *   through the same envelope digests use — a real user message that wakes
 *   the agent, queued when the agent is busy — with the command that stops it.
 *   The notice is recorded before it is sent, so neither a second pass nor a
 *   restart says it twice; a new line from the job starts a new silence.
 */

import { isDesktopRuntime } from "@/shared/api/flockStore";
import { processesAlive } from "@/shared/api/system";
import { errorText } from "@/features/flockctl/commands/types";

import {
  isMonitorJobLive,
  isMonitorJobSilenceDue,
  markLostMonitorJobs,
  type MonitorJob,
  type MonitorJobSilenceNotice,
  monitorJobQuietSince,
  monitorSilenceNoticeText,
} from "./monitorJobs";
import {
  getMonitorJobs,
  isMonitorJobStoreHydrated,
  updateMonitorJobs,
} from "./monitorJobStore";

/** How often the watch looks. Reports come about once a minute. */
export const MONITOR_JOB_WATCH_INTERVAL_MS = 30_000;

let checking = false;

/**
 * Marks every running job whose monitor process is gone as lost. A job that
 * reported while the check ran is left alone: a report is proof of life.
 */
export async function checkMonitorJobProcesses(
  probe: typeof processesAlive = processesAlive,
): Promise<void> {
  if (checking || !isMonitorJobStoreHydrated()) return;
  const running = Object.values(getMonitorJobs()).filter(isMonitorJobLive);
  if (running.length === 0) return;
  checking = true;
  const checkedAt = Date.now();
  try {
    const alive = await probe(
      running.map((job) => ({
        pid: job.monitorPid,
        startedBySecs: Math.floor(job.startedAt / 1000),
      })),
    );
    if (alive.length !== running.length) return;
    updateMonitorJobs((jobsById) => {
      const answers = new Map<string, boolean>();
      running.forEach((job, index) => {
        const current = jobsById[job.jobId];
        if (current && current.lastReportAt <= checkedAt) {
          answers.set(job.jobId, alive[index] === true);
        }
      });
      return markLostMonitorJobs(jobsById, answers, Date.now());
    });
  } catch (error) {
    // Not knowing is not "gone": the jobs keep their state until a check
    // can answer.
    console.warn("Could not check flock-monitor job processes:", error);
  } finally {
    checking = false;
  }
}

function recordNotice(jobId: string, notice: MonitorJobSilenceNotice): void {
  updateMonitorJobs((jobsById) => {
    const job = jobsById[jobId];
    if (!job) return null;
    return { ...jobsById, [jobId]: { ...job, silenceNotice: notice } };
  });
}

async function sendSilenceNotice(job: MonitorJob, now: number): Promise<void> {
  const quietSince = monitorJobQuietSince(job);
  recordNotice(job.jobId, { quietSince, at: now, status: "pending" });
  let result: MonitorJobSilenceNotice;
  try {
    const [{ deliverEnvelope }, { loadSessionForFlockctl, requireSession }] =
      await Promise.all([
        import("./digestDelivery"),
        import("@/features/flockctl/commands/runtime/sessions"),
      ]);
    // An owner the app does not know would park the message in a queue no
    // chat drains.
    await loadSessionForFlockctl(job.ownerSessionId);
    requireSession(job.ownerSessionId);
    const delivery = await deliverEnvelope(
      job.ownerSessionId,
      monitorSilenceNoticeText(job, now),
    );
    result = {
      quietSince,
      at: now,
      status: delivery.status,
      ...(delivery.detail ? { detail: delivery.detail } : {}),
    };
  } catch (error) {
    result = {
      quietSince,
      at: now,
      status: "failed",
      detail: errorText(error),
    };
  }
  if (result.status === "failed") {
    console.warn(
      `Could not tell session ${job.ownerSessionId} that job "${job.label}" is silent:`,
      result.detail,
    );
  }
  recordNotice(job.jobId, result);
}

/**
 * Sends the owner of every newly silent job its one message.
 *
 * Each job is read again just before its notice is sent: recording one notice
 * changes the store, and a pass started by that change must not find the next
 * job still due on a snapshot taken before.
 */
export function noticeSilentMonitorJobs(now: number = Date.now()): void {
  if (!isMonitorJobStoreHydrated()) return;
  for (const jobId of Object.keys(getMonitorJobs())) {
    const job = getMonitorJobs()[jobId];
    if (job && isMonitorJobSilenceDue(job)) void sendSilenceNotice(job, now);
  }
}

/** One pass of both duties. */
export async function watchMonitorJobsOnce(): Promise<void> {
  if (isDesktopRuntime()) await checkMonitorJobProcesses();
  noticeSilentMonitorJobs();
}
