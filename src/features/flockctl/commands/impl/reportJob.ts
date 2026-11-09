import { z } from "zod/v4";

import { FLOCKCTL_BOUNDS } from "../helpers";
import { defineCommand } from "../types";

/** The largest value a CLI number flag carries (clap parses them as u32). */
const U32_MAX = 4_294_967_295;

const singleLine = (field: string) =>
  z
    .string()
    .trim()
    .min(1)
    .regex(/^[^\r\n]*$/, `${field} must be a single line.`);

const reportJobSchema = z
  .object({
    session_id: z
      .string()
      .min(1)
      .max(FLOCKCTL_BOUNDS.id)
      .describe(
        "Id of the session that owns the job: the --session-id the monitor was started with.",
      ),
    job_id: z
      .string()
      .min(1)
      .max(100)
      .regex(
        /^[A-Za-z0-9._-]+$/,
        "Job id must be letters, digits, '.', '_' or '-'.",
      )
      .describe(
        "The monitor's own id for this run of the job (1-100 chars); every report of one run carries the same id.",
      ),
    state_key: singleLine("State key")
      .max(FLOCKCTL_BOUNDS.name)
      .describe("The --state-key the monitor was started with (1-200 chars)."),
    label: singleLine("Label")
      .max(120)
      .describe("The --label the monitor was started with (1-120 chars)."),
    state: z
      .enum(["running", "exited", "stopped", "failed"])
      .describe(
        "running while the producer runs; exited when it ended by itself; stopped when `flock-monitor stop` ended it; failed when the monitor could not keep reading it.",
      ),
    monitor_pid: z
      .number()
      .int()
      .min(1)
      .max(U32_MAX)
      .describe("Process id of the monitor reporting."),
    producer_pid: z
      .number()
      .int()
      .min(1)
      .max(U32_MAX)
      .optional()
      .describe("Process id of the producer the monitor runs."),
    started_at: z
      .number()
      .int()
      .min(0)
      .max(U32_MAX)
      .describe("When the producer started, in seconds since 1970-01-01 UTC."),
    last_output_at: z
      .number()
      .int()
      .min(0)
      .max(U32_MAX)
      .optional()
      .describe(
        "When the producer last printed a line, in seconds since 1970-01-01 UTC. Omit it while it has printed nothing.",
      ),
    silence_minutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .optional()
      .describe(
        "Minutes without a line, while the producer runs, after which the owning session is told once (0-1440; 0 never). Omit it for the app's default.",
      ),
    exit_code: z
      .number()
      .int()
      .min(0)
      .max(U32_MAX)
      .optional()
      .describe("The producer's exit code, with state exited."),
    detail: singleLine("Detail")
      .max(500)
      .optional()
      .describe("How the job ended, in one line (1-500 chars)."),
    log_path: z
      .string()
      .min(1)
      .max(FLOCKCTL_BOUNDS.path)
      .optional()
      .describe(
        "The monitor's log file, where the producer's stderr goes; shown to the owner when the job goes silent.",
      ),
  })
  .strict();

export const reportJobCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Record the state of a flock-monitor job (sent by flock-monitor)",
  description:
    "Record one report from flock-monitor about a job it runs: that its " +
    "producer started, that it still runs and when it last printed a line, " +
    "or how it ended. flock-monitor sends these itself; an agent has no " +
    "reason to. While a job runs, the chat that owns it is shown as waiting " +
    "on it — in the sidebar, above the composer and in its conductor's row — " +
    "with the job's label, age and last output, and a job that stays silent " +
    "past its threshold earns the owner one message saying so. A report for " +
    "a job that already ended changes nothing.",
  helpFooter: `Example:
  flockctl job report --session-id <session-id> --job-id 4242-1762600000 \\
    --state-key build --label "nightly build" --state running \\
    --monitor-pid 4242 --producer-pid 4250 --started-at 1762600000 \\
    --last-output-at 1762600300 --json

Result:
  {"job_id": "...", "state": "running"|"exited"|"stopped"|"failed"|"lost"}
  "state" is the job's state in the app after the report: a job that already
  ended keeps the state it ended in. The first report of a job is refused
  with session_not_found when --session-id names no session.`,
  schema: reportJobSchema,
  execute: async (args) => {
    const [
      { getMonitorJobs, recordMonitorJobReport },
      { loadSessionForFlockctl, requireSession },
    ] = await Promise.all([
      import("@/features/conductor/monitorJobStore"),
      import("../runtime/sessions"),
    ]);
    // Checked once per job, not per heartbeat: a job for a chat that does
    // not exist would be a record nobody can see, and its monitor stops
    // reporting on the refusal.
    if (!getMonitorJobs()[args.job_id]) {
      await loadSessionForFlockctl(args.session_id);
      requireSession(args.session_id);
    }
    const job = recordMonitorJobReport({
      jobId: args.job_id,
      ownerSessionId: args.session_id,
      stateKey: args.state_key,
      label: args.label,
      state: args.state,
      monitorPid: args.monitor_pid,
      ...(args.producer_pid !== undefined
        ? { producerPid: args.producer_pid }
        : {}),
      startedAt: args.started_at * 1000,
      ...(args.last_output_at !== undefined
        ? { lastOutputAt: args.last_output_at * 1000 }
        : {}),
      ...(args.silence_minutes !== undefined
        ? { silenceMinutes: args.silence_minutes }
        : {}),
      ...(args.exit_code !== undefined ? { exitCode: args.exit_code } : {}),
      ...(args.detail ? { detail: args.detail } : {}),
      ...(args.log_path ? { logPath: args.log_path } : {}),
    });
    return { job_id: job.jobId, state: job.state };
  },
});
