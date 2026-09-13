/**
 * When this renderer process started, expressed in the system clock as it reads
 * *now*.
 *
 * The conductor's plan-admission watermark compares a message's `created` stamp
 * against a mark it stored earlier, so it is only as trustworthy as the system
 * clock. A machine whose clock is a day fast (dead CMOS battery, a resumed VM)
 * stores a mark a day in the future; once Windows Time resyncs, every genuinely
 * new plan looks older than the mark and plan admission stops silently.
 *
 * The watermark therefore only supersedes a candidate that predates this
 * process: a genuinely new plan can only have been produced by this session,
 * while the eviction hazard the watermark exists for is entirely in replayed,
 * pre-process transcripts.
 *
 * A wall-clock capture alone would not survive a clock change *during* the
 * session (the start would stay in the future too), so the start is corrected
 * by the monotonic clock: `performance.now()` measures real elapsed time
 * regardless of what the wall clock does, and the difference between the two is
 * the jump. Only backwards drift moves the start — a forward jump must not
 * disown messages this process really did produce.
 */

function monotonicNow(): number {
  return typeof performance?.now === "function"
    ? performance.now()
    : Date.now();
}

const startWall = Date.now();
const startMonotonic = monotonicNow();

/**
 * The process start in current-clock terms.
 *
 * Exported for its own tests: the four inputs are all the state involved, so
 * the clock-jump arithmetic can be checked without moving a real clock.
 */
export function computeProcessStartedAt(args: {
  startWall: number;
  startMonotonic: number;
  nowWall: number;
  nowMonotonic: number;
}): number {
  const elapsed = Math.max(0, args.nowMonotonic - args.startMonotonic);
  // How far the wall clock has moved relative to real elapsed time. Negative
  // means it was set backwards since this process started.
  const drift = args.nowWall - (args.startWall + elapsed);
  return args.startWall + Math.min(0, drift);
}

let overrideForTests: (() => number) | null = null;

/**
 * The moment this process started, as the system clock would stamp it now.
 *
 * Without a monotonic clock (`performance.now()` missing) this degrades to the
 * plain wall-clock capture, which still covers the common case — the clock was
 * corrected before the app was launched.
 */
export function conductorProcessStartedAt(): number {
  if (overrideForTests) return overrideForTests();
  return computeProcessStartedAt({
    startWall,
    startMonotonic,
    nowWall: Date.now(),
    nowMonotonic: monotonicNow(),
  });
}

/** Test seam. Pass `null` to restore the real clock. */
export function setConductorProcessStartedAtForTests(
  override: (() => number) | null,
): void {
  overrideForTests = override;
}
