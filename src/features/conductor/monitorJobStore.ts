/**
 * The record of `flock-monitor` jobs, as one document in the Flock folder.
 *
 * It has to survive a restart: a job runs detached from the app, so the app
 * closing says nothing about whether the job still runs, and a conductor that
 * comes back must still read as waiting on the job it was waiting on. The
 * watch (`useMonitorJobWatch.ts`) checks every running job's monitor process
 * once the record is read, so a job that ended while the app was closed does
 * not stay "running".
 *
 * Writes are held until the folder's copy has been read, the same rule the
 * conductor's other documents keep (`conductorDocuments.ts`): a report that
 * lands in the first second of a start must not write a record of one job over
 * a file of twenty.
 */

import { create } from "zustand";

import { isDesktopRuntime } from "@/shared/api/flockStore";
import { flockDocument } from "@/shared/lib/flockDocument";

import {
  applyMonitorJobReport,
  liveMonitorJobOwnerIds,
  type MonitorJob,
  type MonitorJobReport,
  parseStoredMonitorJob,
  pruneMonitorJobs,
} from "./monitorJobs";

/** Where the record lives under the Flock root. */
export const MONITOR_JOBS_DOCUMENT = "conductor/monitor-jobs.json";

/** Required by the document helper; the record never lived in the browser. */
const MONITOR_JOBS_STORAGE_KEY = "flock:monitor-jobs";

const EMPTY_OWNERS: ReadonlySet<string> = new Set();

interface MonitorJobStoreState {
  jobsById: Record<string, MonitorJob>;
  /**
   * The chats that own a live job. Kept as one set whose reference changes
   * only when its members do, so a sidebar row can select it without
   * re-rendering on every heartbeat.
   */
  liveOwnerIds: ReadonlySet<string>;
}

export const useMonitorJobStore = create<MonitorJobStoreState>(() => ({
  jobsById: {},
  liveOwnerIds: EMPTY_OWNERS,
}));

export function parseMonitorJobsDocument(
  raw: unknown,
): Record<string, MonitorJob> {
  const list =
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as { jobs?: unknown }).jobs)
      ? ((raw as { jobs: unknown[] }).jobs as unknown[])
      : [];
  const jobsById: Record<string, MonitorJob> = {};
  for (const entry of list) {
    const job = parseStoredMonitorJob(entry);
    if (job) jobsById[job.jobId] = job;
  }
  return jobsById;
}

const document = flockDocument<Record<string, MonitorJob>>({
  path: MONITOR_JOBS_DOCUMENT,
  legacyStorageKey: MONITOR_JOBS_STORAGE_KEY,
  parse: parseMonitorJobsDocument,
  serialize: (jobsById) => ({ version: 1, jobs: Object.values(jobsById) }),
});

let hydrated = false;
let writeHeld = false;

function sameMembers(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const member of left) if (!right.has(member)) return false;
  return true;
}

function commit(jobsById: Record<string, MonitorJob>): void {
  const previous = useMonitorJobStore.getState().liveOwnerIds;
  const owners = liveMonitorJobOwnerIds(jobsById);
  useMonitorJobStore.setState({
    jobsById,
    liveOwnerIds: sameMembers(previous, owners)
      ? previous
      : owners.size === 0
        ? EMPTY_OWNERS
        : owners,
  });
  if (hydrated || !isDesktopRuntime()) {
    document.write(jobsById);
  } else {
    writeHeld = true;
  }
}

export function getMonitorJobs(): Readonly<Record<string, MonitorJob>> {
  return useMonitorJobStore.getState().jobsById;
}

/** Folds one `flockctl job report` into the record and returns the job. */
export function recordMonitorJobReport(
  report: MonitorJobReport,
  now: number = Date.now(),
): MonitorJob {
  const { jobsById, job } = applyMonitorJobReport(
    getMonitorJobs(),
    report,
    now,
  );
  commit(jobsById);
  return job;
}

/**
 * Replaces the record with what `update` makes of it; `null` changes nothing.
 * For the watch, which marks lost jobs and records the silences it told.
 */
export function updateMonitorJobs(
  update: (
    jobsById: Readonly<Record<string, MonitorJob>>,
  ) => Record<string, MonitorJob> | null,
): void {
  const next = update(getMonitorJobs());
  if (next) commit(next);
}

/** True once the folder's copy has been read (or there is no folder). */
export function isMonitorJobStoreHydrated(): boolean {
  return hydrated || !isDesktopRuntime();
}

const hydrationWaiters = new Set<() => void>();

/**
 * Calls `callback` once the folder's copy has been read, and at once when it
 * already has. Returns a function that drops a callback still waiting.
 */
export function whenMonitorJobStoreHydrated(callback: () => void): () => void {
  if (isMonitorJobStoreHydrated()) {
    callback();
    return () => {};
  }
  hydrationWaiters.add(callback);
  return () => {
    hydrationWaiters.delete(callback);
  };
}

function releaseHydrationWaiters(): void {
  const waiters = [...hydrationWaiters];
  hydrationWaiters.clear();
  for (const waiter of waiters) {
    try {
      waiter();
    } catch (error) {
      console.error("A flock-monitor job record waiter failed:", error);
    }
  }
}

/**
 * Folds the folder's record into memory. A job memory already holds wins: it
 * is one this run has heard from since the start.
 */
export async function hydrateMonitorJobStore(
  now: number = Date.now(),
): Promise<void> {
  if (hydrated) return;
  const stored = await document.read();
  const live = getMonitorJobs();
  const merged = pruneMonitorJobs({ ...(stored ?? {}), ...live }, now);
  hydrated = true;
  if (stored || writeHeld || Object.keys(live).length > 0) {
    writeHeld = false;
    commit(merged);
  }
  releaseHydrationWaiters();
}

/** Waits for a queued write to land. For tests and for shutdown. */
export function flushMonitorJobWrites(): Promise<void> {
  return document.flush();
}

/** Test seam: an empty, unhydrated record. */
export function resetMonitorJobStoreForTests(
  jobsById: Record<string, MonitorJob> = {},
): void {
  hydrated = false;
  writeHeld = false;
  useMonitorJobStore.setState({
    jobsById,
    liveOwnerIds: liveMonitorJobOwnerIds(jobsById),
  });
}
