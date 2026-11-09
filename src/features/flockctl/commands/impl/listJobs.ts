import { z } from "zod/v4";

import { FLOCKCTL_BOUNDS } from "../helpers";
import { defineCommand } from "../types";

const listJobsSchema = z
  .object({
    session_id: z
      .string()
      .max(FLOCKCTL_BOUNDS.id)
      .optional()
      .describe(
        "Only list the jobs this session owns. Omit it for every session's jobs.",
      ),
    include_ended: z
      .boolean()
      .default(false)
      .describe(
        "Also list jobs that ended in the last three days. Defaults to false: running jobs only.",
      ),
  })
  .strict();

function iso(ms: number | undefined): string | null {
  return typeof ms === "number" ? new Date(ms).toISOString() : null;
}

export const listJobsCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "List the flock-monitor jobs the app knows about",
  description:
    "List the jobs flock-monitor runs for Flock sessions, as the app last " +
    "heard of them: the owning session, label and state key, the producer's " +
    "process id, when it started, when it last printed a line, and how it " +
    "ended. A job whose monitor process is gone without saying how it ended " +
    "is listed as lost. Does not change anything on screen.",
  helpFooter: `Example:
  flockctl job list --session-id <session-id> --json

Result:
  {"jobs": [{"job_id": "...", "session_id": "...", "state_key": "...", "label": "...",
             "state": "running"|"exited"|"stopped"|"failed"|"lost",
             "monitor_pid": 4242, "producer_pid": 4250|null,
             "started_at": "...", "last_output_at": "..."|null,
             "last_report_at": "...", "silence_minutes": 15,
             "silence_noticed_at": "..."|null,
             "ended_at": "..."|null, "exit_code": 0|null, "detail": "..."|null}]}
  Oldest first. Stop a running job with
  \`flock-monitor stop --session-id <session-id> --state-key <state-key>\`.`,
  schema: listJobsSchema,
  execute: async (args) => {
    const [{ getMonitorJobs }, { isMonitorJobLive, monitorJobSilenceMs }] =
      await Promise.all([
        import("@/features/conductor/monitorJobStore"),
        import("@/features/conductor/monitorJobs"),
      ]);
    const jobs = Object.values(getMonitorJobs())
      .filter((job) =>
        args.session_id ? job.ownerSessionId === args.session_id : true,
      )
      .filter((job) => args.include_ended || isMonitorJobLive(job))
      .sort((left, right) => left.startedAt - right.startedAt)
      .map((job) => ({
        job_id: job.jobId,
        session_id: job.ownerSessionId,
        state_key: job.stateKey,
        label: job.label,
        state: job.state,
        monitor_pid: job.monitorPid,
        producer_pid: job.producerPid ?? null,
        started_at: iso(job.startedAt),
        last_output_at: iso(job.lastOutputAt),
        last_report_at: iso(job.lastReportAt),
        silence_minutes: monitorJobSilenceMs(job) / 60_000,
        silence_noticed_at: iso(job.silenceNotice?.at),
        ended_at: iso(job.endedAt),
        exit_code: job.exitCode ?? null,
        detail: job.detail ?? null,
      }));
    return { jobs };
  },
});
