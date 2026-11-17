// How long a run has left at the pace it keeps now, for the activity strip.
import type { RunSummary } from "../types";
import { cellProgress } from "./benchmarkActivity";
import { runWindowCloses } from "./benchmarkPlan";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * How far back a pace is read. A run flies a few attempts at once when it
 * starts or is taken up again and many more an hour later, so what it did
 * over its whole life says little about what it does now (11-17: a run that
 * had crawled through an evening of stops read "26h left" while forty
 * attempts at once left it about six).
 */
const WINDOW_MS = 45 * MINUTE;
/** The least watching and the fewest tests settled a pace is read from. */
const MIN_WATCHED_MS = 10 * MINUTE;
const MIN_SETTLED = 3;
/** Tests a warning is read from: a short stretch is shown, not yet believed. */
const WARNING_MIN_SETTLED = 10;

interface Sample {
  at: number;
  settled: number;
}

/**
 * Where each dispatching run stood when its count of settled tests last
 * moved, back to the newest moment the window still reaches. Kept while the
 * app runs: a pace is something watched, not something a summary carries.
 */
const watched = new Map<string, Sample[]>();

/**
 * Note where a run stands now. Called wherever run summaries arrive, on
 * every page. A run that stands keeps no pace: it starts over, at whatever
 * number of attempts its accounts then allow, when it is taken up again.
 */
export function observeRunPace(run: RunSummary, now: number): void {
  if (run.state !== "running") {
    watched.delete(run.id);
    return;
  }
  const { settled } = cellProgress(run);
  const samples = watched.get(run.id) ?? [];
  const last = samples.at(-1);
  // A count that went back is another plan's count.
  if (last && settled < last.settled) samples.length = 0;
  if (samples.length === 0 || settled !== last?.settled)
    samples.push({ at: now, settled });
  // The first sample kept is the newest one the window no longer holds, so
  // the stretch read is the window or a little more, never less.
  while (samples.length > 1 && now - samples[1].at >= WINDOW_MS)
    samples.shift();
  watched.set(run.id, samples);
}

export interface RunPace {
  /** What is left at the pace of the stretch watched, in milliseconds. */
  remainingMs: number;
  /** How long the stretch the pace is read from is. */
  watchedMs: number;
  /** When the run's window closes and its unfinished tests are dropped. */
  closesAt: number;
  /** The run would still be measuring when its window closes. */
  pastWindow: boolean;
}

/**
 * The time a dispatching run has left at the pace it has kept lately: the
 * tests it settled over the stretch watched, against the tests it has left.
 * An estimate, and none at all for a run that stands, has nothing left, or
 * has not been watched settle enough yet.
 */
export function runPace(run: RunSummary, now: number): RunPace | null {
  if (run.state !== "running") return null;
  const { settled, total } = cellProgress(run);
  const samples = watched.get(run.id) ?? [];
  // The newest moment the window no longer holds, else when watching began.
  const since =
    samples.findLast((sample) => now - sample.at >= WINDOW_MS) ?? samples[0];
  if (!since || settled >= total) return null;
  const watchedMs = now - since.at;
  const gained = settled - since.settled;
  if (watchedMs < MIN_WATCHED_MS || gained < MIN_SETTLED) return null;
  const remainingMs = (watchedMs / gained) * (total - settled);
  const closesAt = runWindowCloses(run, now);
  return {
    remainingMs,
    watchedMs,
    closesAt,
    pastWindow: gained >= WARNING_MIN_SETTLED && now + remainingMs > closesAt,
  };
}

/** `35m`, `5h 40m`, `27h`, `3d`: a span no finer than an estimate deserves. */
export function roughSpan(milliseconds: number): string {
  if (milliseconds < HOUR) {
    const minutes = Math.max(5, Math.round(milliseconds / (5 * MINUTE)) * 5);
    return minutes >= 60 ? "1h" : `${minutes}m`;
  }
  if (milliseconds < 10 * HOUR) {
    const tens = Math.round(milliseconds / (10 * MINUTE));
    const minutes = (tens % 6) * 10;
    const hours = Math.floor(tens / 6);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const hours = Math.round(milliseconds / HOUR);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}
