// How long a run has left at the pace it has kept, for the activity strip.
import type { RunSummary } from "../types";
import { cellProgress } from "./benchmarkActivity";
import { runWindowCloses } from "./benchmarkPlan";

/**
 * Tests a pace is read from: fewer say more about which tests happened to
 * come first than about the run.
 */
const PACE_MIN_SETTLED = 5;
/** Tests a warning is read from: an early pace is shown, not yet believed. */
const WARNING_MIN_SETTLED = 20;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface RunPace {
  /** What is left at the pace so far, in milliseconds. */
  remainingMs: number;
  /** When the run's window closes and its unfinished tests are dropped. */
  closesAt: number;
  /** The run would still be measuring when its window closes. */
  pastWindow: boolean;
}

/**
 * The time a dispatching run has left: its time at work so far, pauses left
 * out, over the tests it settled, times the tests it has left. An estimate,
 * and none at all for a run that stands, has settled too little to tell, or
 * has nothing left.
 */
export function runPace(run: RunSummary, now: number): RunPace | null {
  if (run.state !== "running") return null;
  const { settled, total } = cellProgress(run);
  if (settled < PACE_MIN_SETTLED || settled >= total) return null;
  const resting =
    run.pausedSince == null ? 0 : Math.max(0, now - run.pausedSince);
  const worked = now - run.createdAt - (run.pausedMs ?? 0) - resting;
  if (worked <= 0) return null;
  const remainingMs = (worked / settled) * (total - settled);
  const closesAt = runWindowCloses(run, now);
  return {
    remainingMs,
    closesAt,
    pastWindow: settled >= WARNING_MIN_SETTLED && now + remainingMs > closesAt,
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
