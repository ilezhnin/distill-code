/**
 * The jobs agents start under `flock-monitor`, as the app knows them.
 *
 * A worker that has to wait on something long — a build, a scrape, a test
 * campaign — writes a script, starts it detached under `flock-monitor` with a
 * chat as its owner, and ends its turn. The producer's lines reach the owner
 * later as messages. Until 2026-11-08 the app knew nothing else: the owner sat
 * idle in the sidebar and above the composer, the wave stall detector saw no
 * work, and a producer that hung while alive sent nothing, so nobody was ever
 * told. The operator of a long conductor read that as "nothing works", and the
 * conductor wrote its own ten-minute heartbeat to get by.
 *
 * Now the monitor reports each job through `flockctl job report`: once when
 * the producer starts, about once a minute while it runs (with the time of its
 * last line), and once when it ends. These are the pure halves of that record:
 * how a report folds into it, when a job counts as gone, and when a silence is
 * owed a message. The store (`monitorJobStore.ts`) persists it; the watch
 * (`useMonitorJobWatch.ts`) checks the processes and sends the messages.
 */

export type MonitorJobState =
  /** The producer runs, as far as the app has heard. */
  | "running"
  /** The producer exited by itself. */
  | "exited"
  /** `flock-monitor stop` ended it. */
  | "stopped"
  /** The monitor itself failed (it could not read the producer's output). */
  | "failed"
  /** The monitor process is gone and never said how the job ended. */
  | "lost";

/** What the owner was told about one silence, so it is said once. */
export interface MonitorJobSilenceNotice {
  /** The start of the silence it was about: the last output, or the start. */
  quietSince: number;
  /** When it was sent. */
  at: number;
  status: "pending" | "dispatched" | "queued" | "failed";
  detail?: string;
}

export interface MonitorJob {
  /** The monitor's own id for this run; unique per run. */
  jobId: string;
  /** The chat the job's output is delivered to. */
  ownerSessionId: string;
  stateKey: string;
  label: string;
  monitorPid: number;
  producerPid?: number;
  /** When the producer started, ms since the epoch. */
  startedAt: number;
  /** When the producer last printed a line, as of the latest report. */
  lastOutputAt?: number;
  /** When the app last heard from the job's monitor (the app's clock). */
  lastReportAt: number;
  /** Minutes of silence worth telling the owner about; 0 never; absent is the default. */
  silenceMinutes?: number;
  /** The monitor's log, where the producer's stderr goes. */
  logPath?: string;
  state: MonitorJobState;
  endedAt?: number;
  exitCode?: number;
  /** How it ended, in the monitor's words or the app's. */
  detail?: string;
  silenceNotice?: MonitorJobSilenceNotice;
}

/** One `flockctl job report`, in the app's units (ms). */
export interface MonitorJobReport {
  jobId: string;
  ownerSessionId: string;
  stateKey: string;
  label: string;
  state: Exclude<MonitorJobState, "lost">;
  monitorPid: number;
  producerPid?: number;
  startedAt: number;
  lastOutputAt?: number;
  silenceMinutes?: number;
  logPath?: string;
  exitCode?: number;
  detail?: string;
}

/**
 * Silence worth one message when the job's report names no threshold. The
 * conductor that asked for this ran its own heartbeat every ten minutes; a
 * little longer leaves room for a producer that prints once per stage.
 */
export const DEFAULT_MONITOR_SILENCE_MINUTES = 15;

/** The longest silence threshold a report may ask for: a day. */
export const MAX_MONITOR_SILENCE_MINUTES = 24 * 60;

/** How often a running job's monitor reports, in the monitor itself. */
export const MONITOR_HEARTBEAT_MS = 60_000;

/** How long an ended job stays readable in `flockctl job list`. */
export const MONITOR_JOB_RETENTION_MS = 3 * 24 * 60 * 60_000;

/** The most jobs the record keeps; ended ones go first. */
export const MAX_MONITOR_JOBS = 200;

export function isMonitorJobLive(job: Pick<MonitorJob, "state">): boolean {
  return job.state === "running";
}

/**
 * The record after one report.
 *
 * A job the monitor itself said had ended stays ended: a retried exit report
 * changes nothing, and a heartbeat can never come after it. A job the app
 * marked lost comes back to life on a report, since a report is proof its
 * monitor runs — a process check can be wrong, a monitor talking cannot. A
 * newer run of the same state key ends whatever older record of it still says
 * running: the monitor's owner lock admits one run per key, so the older one
 * is certainly gone.
 */
export function applyMonitorJobReport(
  jobsById: Readonly<Record<string, MonitorJob>>,
  report: MonitorJobReport,
  now: number,
): { jobsById: Record<string, MonitorJob>; job: MonitorJob } {
  const existing = jobsById[report.jobId];
  if (existing && existing.state !== "running" && existing.state !== "lost") {
    return { jobsById: { ...jobsById }, job: existing };
  }
  const ended = report.state !== "running";
  const lastOutputAt = latest(existing?.lastOutputAt, report.lastOutputAt);
  const job: MonitorJob = {
    jobId: report.jobId,
    ownerSessionId: report.ownerSessionId,
    stateKey: report.stateKey,
    label: report.label,
    monitorPid: report.monitorPid,
    ...(report.producerPid !== undefined
      ? { producerPid: report.producerPid }
      : existing?.producerPid !== undefined
        ? { producerPid: existing.producerPid }
        : {}),
    startedAt: existing?.startedAt ?? report.startedAt,
    ...(lastOutputAt !== undefined ? { lastOutputAt } : {}),
    lastReportAt: now,
    ...(report.silenceMinutes !== undefined
      ? { silenceMinutes: report.silenceMinutes }
      : {}),
    ...(report.logPath ? { logPath: report.logPath } : {}),
    state: report.state,
    ...(ended ? { endedAt: now } : {}),
    ...(ended && report.exitCode !== undefined
      ? { exitCode: report.exitCode }
      : {}),
    ...(ended && report.detail ? { detail: report.detail } : {}),
    ...(existing?.silenceNotice
      ? { silenceNotice: existing.silenceNotice }
      : {}),
  };
  const next: Record<string, MonitorJob> = {};
  for (const [jobId, other] of Object.entries(jobsById)) {
    next[jobId] =
      jobId !== job.jobId &&
      isMonitorJobLive(other) &&
      other.ownerSessionId === job.ownerSessionId &&
      other.stateKey === job.stateKey
        ? {
            ...other,
            state: "lost",
            endedAt: now,
            detail: "A newer run of the same state key started.",
          }
        : other;
  }
  next[job.jobId] = job;
  return { jobsById: pruneMonitorJobs(next, now), job };
}

/**
 * Marks the running jobs whose monitor process is gone as lost.
 *
 * `monitorAlive` answers for each running job; a job it has no answer for is
 * left as it is, because "could not check" is not "gone".
 */
export function markLostMonitorJobs(
  jobsById: Readonly<Record<string, MonitorJob>>,
  monitorAlive: ReadonlyMap<string, boolean>,
  now: number,
): Record<string, MonitorJob> | null {
  let changed = false;
  const next: Record<string, MonitorJob> = { ...jobsById };
  for (const job of Object.values(jobsById)) {
    if (!isMonitorJobLive(job) || monitorAlive.get(job.jobId) !== false) {
      continue;
    }
    changed = true;
    next[job.jobId] = {
      ...job,
      state: "lost",
      endedAt: now,
      detail: "Its monitor process ended without saying how the job ended.",
    };
  }
  return changed ? next : null;
}

/** Drops ended jobs past their retention, then the oldest past the cap. */
export function pruneMonitorJobs(
  jobsById: Record<string, MonitorJob>,
  now: number,
): Record<string, MonitorJob> {
  const kept = Object.values(jobsById).filter(
    (job) =>
      isMonitorJobLive(job) ||
      now - (job.endedAt ?? job.lastReportAt) < MONITOR_JOB_RETENTION_MS,
  );
  if (kept.length > MAX_MONITOR_JOBS) {
    kept.sort(
      (left, right) =>
        Number(isMonitorJobLive(right)) - Number(isMonitorJobLive(left)) ||
        (right.endedAt ?? right.lastReportAt) -
          (left.endedAt ?? left.lastReportAt),
    );
    kept.length = MAX_MONITOR_JOBS;
  }
  if (kept.length === Object.keys(jobsById).length) return jobsById;
  return Object.fromEntries(kept.map((job) => [job.jobId, job]));
}

/** Where the job's current silence began: its last line, or its start. */
export function monitorJobQuietSince(job: MonitorJob): number {
  return Math.max(job.startedAt, job.lastOutputAt ?? job.startedAt);
}

/** The silence threshold for a job, in ms; 0 when it asked for none. */
export function monitorJobSilenceMs(
  job: Pick<MonitorJob, "silenceMinutes">,
): number {
  const minutes = job.silenceMinutes ?? DEFAULT_MONITOR_SILENCE_MINUTES;
  return Math.max(0, minutes) * 60_000;
}

/**
 * True when a running job has been silent past its threshold and its owner
 * has not been told about this silence yet.
 *
 * The evidence is the monitor's own report, not the app's clock: the job is
 * silent when its latest report — which carries the time of the producer's
 * last line — came that long after the line. Judging by "now" would call a
 * job silent in the minute between a line and the heartbeat that says so, and
 * would call one silent whose monitor stopped reporting for any reason. A
 * silence is said once; a new line starts a new one.
 */
export function isMonitorJobSilenceDue(job: MonitorJob): boolean {
  if (!isMonitorJobLive(job)) return false;
  const threshold = monitorJobSilenceMs(job);
  if (threshold <= 0) return false;
  const quietSince = monitorJobQuietSince(job);
  if (job.lastReportAt - quietSince < threshold) return false;
  return job.silenceNotice?.quietSince !== quietSince;
}

function minutesBetween(from: number, to: number): number {
  return Math.max(0, Math.round((to - from) / 60_000));
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9._:/=-]+$/.test(value)
    ? value
    : `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * The one message an owner gets about a silent job: what is silent, for how
 * long, that the producer still runs, and how to look at it or stop it.
 */
export function monitorSilenceNoticeText(job: MonitorJob, now: number): string {
  const quietSince = monitorJobQuietSince(job);
  const silentMinutes = minutesBetween(quietSince, job.lastReportAt);
  const runningMinutes = minutesBetween(job.startedAt, now);
  const producer =
    job.producerPid !== undefined
      ? `its producer (pid ${job.producerPid})`
      : "its producer";
  const lines = [
    `[monitor: ${job.label}] No output for ${silentMinutes} minutes, and ${producer} is still running.`,
    job.lastOutputAt !== undefined
      ? `It started ${runningMinutes} minutes ago; its last line came ${minutesBetween(job.lastOutputAt, now)} minutes ago.`
      : `It started ${runningMinutes} minutes ago and has printed nothing yet.`,
    "If it is stuck, look at what it is doing" +
      (job.logPath ? ` (its stderr is in ${job.logPath})` : "") +
      ", or stop it with:",
    `  flock-monitor stop --session-id ${quoteArg(job.ownerSessionId)} --state-key ${quoteArg(job.stateKey)}`,
    "This is said once per silence: Flock says it again only after the job prints something and goes quiet again.",
  ];
  return lines.join("\n");
}

/** A strict read of one stored job, or `null` when it is not one. */
export function parseStoredMonitorJob(raw: unknown): MonitorJob | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const text = (key: string) =>
    typeof value[key] === "string" && (value[key] as string).length > 0
      ? (value[key] as string)
      : undefined;
  const number = (key: string) =>
    typeof value[key] === "number" && Number.isFinite(value[key])
      ? (value[key] as number)
      : undefined;
  const jobId = text("jobId");
  const ownerSessionId = text("ownerSessionId");
  const stateKey = text("stateKey");
  const label = text("label");
  const monitorPid = number("monitorPid");
  const startedAt = number("startedAt");
  const lastReportAt = number("lastReportAt");
  const state = value.state;
  if (
    !jobId ||
    !ownerSessionId ||
    !stateKey ||
    !label ||
    monitorPid === undefined ||
    startedAt === undefined ||
    lastReportAt === undefined ||
    (state !== "running" &&
      state !== "exited" &&
      state !== "stopped" &&
      state !== "failed" &&
      state !== "lost")
  ) {
    return null;
  }
  const notice = value.silenceNotice as Record<string, unknown> | undefined;
  const silenceNotice: MonitorJobSilenceNotice | undefined =
    notice &&
    typeof notice.quietSince === "number" &&
    typeof notice.at === "number" &&
    (notice.status === "pending" ||
      notice.status === "dispatched" ||
      notice.status === "queued" ||
      notice.status === "failed")
      ? {
          quietSince: notice.quietSince,
          at: notice.at,
          status: notice.status,
          ...(typeof notice.detail === "string"
            ? { detail: notice.detail }
            : {}),
        }
      : undefined;
  const optional = {
    producerPid: number("producerPid"),
    lastOutputAt: number("lastOutputAt"),
    silenceMinutes: number("silenceMinutes"),
    logPath: text("logPath"),
    endedAt: number("endedAt"),
    exitCode: number("exitCode"),
    detail: text("detail"),
  };
  return {
    jobId,
    ownerSessionId,
    stateKey,
    label,
    monitorPid,
    startedAt,
    lastReportAt,
    state,
    ...Object.fromEntries(
      Object.entries(optional).filter(([, entry]) => entry !== undefined),
    ),
    ...(silenceNotice ? { silenceNotice } : {}),
  };
}

function latest(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

/** The live jobs a set of chats owns, oldest first. */
export function liveMonitorJobsFor(
  jobsById: Readonly<Record<string, MonitorJob>>,
  sessionIds: ReadonlySet<string>,
): MonitorJob[] {
  const jobs: MonitorJob[] = [];
  for (const job of Object.values(jobsById)) {
    if (isMonitorJobLive(job) && sessionIds.has(job.ownerSessionId)) {
      jobs.push(job);
    }
  }
  return jobs.sort((left, right) => left.startedAt - right.startedAt);
}

/** How many live jobs a chat owns, under any of its ids. */
export function liveMonitorJobCount(
  jobsById: Readonly<Record<string, MonitorJob>>,
  sessionIds: ReadonlyArray<string | null | undefined>,
): number {
  let count = 0;
  for (const key in jobsById) {
    const job = jobsById[key];
    if (
      job &&
      isMonitorJobLive(job) &&
      sessionIds.includes(job.ownerSessionId)
    ) {
      count += 1;
    }
  }
  return count;
}

/** The chats that own a live job. */
export function liveMonitorJobOwnerIds(
  jobsById: Readonly<Record<string, MonitorJob>>,
): ReadonlySet<string> {
  const owners = new Set<string>();
  for (const key in jobsById) {
    const job = jobsById[key];
    if (job && isMonitorJobLive(job)) owners.add(job.ownerSessionId);
  }
  return owners;
}
