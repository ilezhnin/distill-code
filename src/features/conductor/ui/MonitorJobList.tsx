import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/shared/lib/cn";

import { formatRunDuration } from "../brigadeChipSummary";
import { type MonitorJob, monitorJobQuietSince } from "../monitorJobs";

/** A clock that moves every `intervalMs`, for ages that count up on screen. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** `5m 10s` → `5m`: an age on a status line needs no seconds past a minute. */
function shortAge(ms: number): string {
  const text = formatRunDuration(ms);
  return ms >= 60_000 ? text.replace(/ \d+s$/, "") : text;
}

/**
 * The words after a job's label: how long it runs, when it last printed a
 * line, and — once its owner was told it went quiet — that it is silent.
 */
export function monitorJobFacts(
  job: MonitorJob,
  now: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): { parts: string[]; silent?: string } {
  const parts = [
    t("conductor.jobs.running", { duration: shortAge(now - job.startedAt) }),
    job.lastOutputAt !== undefined
      ? t("conductor.jobs.lastOutput", {
          duration: shortAge(now - job.lastOutputAt),
        })
      : t("conductor.jobs.noOutput"),
  ];
  const quietSince = monitorJobQuietSince(job);
  const silent =
    job.silenceNotice?.quietSince === quietSince
      ? t("conductor.jobs.silent", { duration: shortAge(now - quietSince) })
      : undefined;
  return { parts, ...(silent ? { silent } : {}) };
}

/**
 * The running `flock-monitor` jobs a chat and its agents wait on, one line
 * each: the job's label, whose it is when it is not this chat's own, how long
 * it has run and when it last printed anything. A job an agent of this chat
 * owns opens that agent's chat, which is where its output lands (LAWS/WAVES.md:
 * every surface that says an agent works offers a way into its chat).
 */
export function MonitorJobList({
  jobs,
  agentName,
  onOpenOwner,
  className,
}: {
  jobs: readonly MonitorJob[];
  /**
   * The name of the agent of this chat that owns a job, or nothing for a job
   * the chat owns itself, which needs no way in: it is the chat on screen.
   */
  agentName: (sessionId: string) => string | undefined;
  onOpenOwner?: (sessionId: string) => void;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const now = useNow(15_000);
  if (jobs.length === 0) return null;
  return (
    <ul
      className={cn("min-w-0 space-y-0.5", className)}
      data-testid="monitor-job-list"
    >
      {jobs.map((job) => {
        const { parts, silent } = monitorJobFacts(job, now, t);
        const name = agentName(job.ownerSessionId);
        const body = (
          <>
            <span className="font-medium text-foreground">{job.label}</span>
            {name ? <span> · {name}</span> : null}
            <span> · {parts.join(" · ")}</span>
            {silent ? <span className="text-warning"> · {silent}</span> : null}
          </>
        );
        return (
          <li
            key={job.jobId}
            className="min-w-0 truncate pl-4 text-xs text-muted-foreground"
            data-testid="monitor-job-row"
            title={`${job.label} (${job.stateKey})`}
          >
            {name && onOpenOwner ? (
              <button
                type="button"
                className="min-w-0 max-w-full truncate text-left underline-offset-2 hover:text-foreground hover:underline"
                aria-label={t("conductor.jobs.open", {
                  name,
                })}
                onClick={() => onOpenOwner(job.ownerSessionId)}
              >
                {body}
              </button>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}
