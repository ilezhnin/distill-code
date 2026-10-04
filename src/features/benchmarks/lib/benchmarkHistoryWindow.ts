/** Zoom choices above the points history, shortest first. */
export const RANGE_CHOICES = ["1w", "1m", "6m", "1y", "max"] as const;
export type RangeChoice = (typeof RANGE_CHOICES)[number];

/** A span of time in epoch milliseconds, both ends included. */
export interface TimeWindow {
  start: number;
  end: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The narrowest window the navigator can be squeezed to. */
export const MIN_WINDOW_MS = HOUR;

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), high);

/** Calendar months back from the end; a week is a fixed length. */
const RANGE_MONTHS: Partial<Record<RangeChoice, number>> = {
  "1m": 1,
  "6m": 6,
  "1y": 12,
};
const RANGE_MS: Partial<Record<RangeChoice, number>> = {
  "1w": 7 * DAY,
};

/**
 * The window a zoom choice shows. It ends at the newest measurement; a range
 * longer than the history shows all of it, like max.
 */
export function windowFor(choice: RangeChoice, extent: TimeWindow): TimeWindow {
  if (choice === "max") return { ...extent };
  let start = extent.end - (RANGE_MS[choice] ?? 0);
  const months = RANGE_MONTHS[choice];
  if (months) {
    const date = new Date(extent.end);
    date.setMonth(date.getMonth() - months);
    start = date.getTime();
  }
  return start <= extent.start ? { ...extent } : { start, end: extent.end };
}

/**
 * The zoom choice whose window `view` is, within `tolerance` at both ends, so
 * a navigator window dragged back onto a range lights its button again. The
 * whole history reads as max even where longer ranges show the same.
 */
export function matchingRange(
  view: TimeWindow,
  extent: TimeWindow,
  tolerance = 0,
): RangeChoice | null {
  const near = (a: number, b: number) => Math.abs(a - b) <= tolerance;
  const order: RangeChoice[] = [
    "max",
    ...RANGE_CHOICES.filter((choice) => choice !== "max"),
  ];
  return (
    order.find((choice) => {
      const window = windowFor(choice, extent);
      return near(window.start, view.start) && near(window.end, view.end);
    }) ?? null
  );
}

/**
 * Keeps a window inside the history and at least `minSpan` wide, keeping its
 * width where it can.
 */
export function clampWindow(
  view: TimeWindow,
  extent: TimeWindow,
  minSpan = MIN_WINDOW_MS,
): TimeWindow {
  const full = extent.end - extent.start;
  const span = Math.min(full, Math.max(view.end - view.start, minSpan));
  const start = clamp(view.start, extent.start, extent.end - span);
  return { start, end: start + span };
}

/** Moves the window by `delta` without changing its width or leaving the history. */
export function panWindow(
  view: TimeWindow,
  delta: number,
  extent: TimeWindow,
): TimeWindow {
  return clampWindow(
    { start: view.start + delta, end: view.end + delta },
    extent,
    0,
  );
}

/** Moves one edge to `at`; the other edge stays and the window keeps its minimum width. */
export function resizeWindow(
  view: TimeWindow,
  edge: "start" | "end",
  at: number,
  extent: TimeWindow,
  minSpan = MIN_WINDOW_MS,
): TimeWindow {
  const min = Math.min(minSpan, extent.end - extent.start);
  if (edge === "start")
    return {
      start: Math.max(extent.start, Math.min(at, view.end - min)),
      end: view.end,
    };
  return {
    start: view.start,
    end: Math.min(extent.end, Math.max(at, view.start + min)),
  };
}

/** Centres the window on `at`, as a press on the navigator outside the window does. */
export function centerWindow(
  view: TimeWindow,
  at: number,
  extent: TimeWindow,
): TimeWindow {
  return panWindow(view, at - (view.start + view.end) / 2, extent);
}

/** Pans the window just far enough to show `at`. */
export function revealTime(
  view: TimeWindow,
  at: number,
  extent: TimeWindow,
): TimeWindow {
  if (at < view.start) return panWindow(view, at - view.start, extent);
  if (at > view.end) return panWindow(view, at - view.end, extent);
  return view;
}

/** Index of the position nearest to `x` in ascending positions; a tie goes to the earlier one. */
export function nearestIndex(positions: number[], x: number): number {
  if (!positions.length) return -1;
  let low = 0;
  let high = positions.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (positions[middle] < x) low = middle + 1;
    else high = middle;
  }
  if (low > 0 && x - positions[low - 1] <= positions[low] - x) return low - 1;
  return low;
}

/** Centre distance that keeps two markers (radius 6 plus stroke) apart. */
export const POINT_GAP = 16;

/**
 * Horizontal positions for ascending times across a window. Time stays
 * proportional where it can; observations minutes apart inside the window are
 * pushed apart so every marker stays clickable, and too many for the width
 * fall back to even spacing. Times outside the window keep their proportional
 * place so a line can run off the edge toward them.
 */
export function placePoints(
  times: number[],
  view: TimeWindow,
  left: number,
  right: number,
  gap = POINT_GAP,
): number[] {
  const span = view.end - view.start;
  const width = right - left;
  const placed = times.map((at) =>
    span > 0 ? left + ((at - view.start) / span) * width : (left + right) / 2,
  );
  const inside = times.flatMap((at, index) =>
    at >= view.start && at <= view.end ? [index] : [],
  );
  const count = inside.length;
  if (count < 2) return placed;
  if ((count - 1) * gap >= width) {
    inside.forEach((index, order) => {
      placed[index] = left + (order * width) / (count - 1);
    });
    return placed;
  }
  for (let order = 1; order < count; order += 1)
    placed[inside[order]] = Math.max(
      placed[inside[order]],
      placed[inside[order - 1]] + gap,
    );
  const last = inside[count - 1];
  placed[last] = Math.min(placed[last], right);
  for (let order = count - 2; order >= 0; order -= 1)
    placed[inside[order]] = Math.min(
      placed[inside[order]],
      placed[inside[order + 1]] - gap,
    );
  return placed;
}

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * An SVG path through points with ascending x as a monotone cubic: smooth,
 * yet never above or below the values it joins.
 */
export function smoothPath(xs: number[], ys: number[]): string {
  const count = xs.length;
  if (!count) return "";
  const start = `M${round(xs[0])},${round(ys[0])}`;
  if (count === 1) return start;
  if (count === 2) return `${start} L${round(xs[1])},${round(ys[1])}`;
  const widths: number[] = [];
  const slopes: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    widths.push(xs[index + 1] - xs[index]);
    slopes.push((ys[index + 1] - ys[index]) / widths[index]);
  }
  // Fritsch-Butland tangents, then the Fritsch-Carlson limit per interval.
  const tangents = xs.map((_, index) => {
    if (index === 0) return slopes[0];
    if (index === count - 1) return slopes[count - 2];
    const before = slopes[index - 1];
    const after = slopes[index];
    if (before * after <= 0) return 0;
    const [h0, h1] = [widths[index - 1], widths[index]];
    return (3 * (h0 + h1)) / ((2 * h1 + h0) / before + (h1 + 2 * h0) / after);
  });
  for (let index = 0; index < count - 1; index += 1) {
    const slope = slopes[index];
    if (slope === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const alpha = tangents[index] / slope;
    const beta = tangents[index + 1] / slope;
    const length = alpha * alpha + beta * beta;
    if (length > 9) {
      const scale = 3 / Math.sqrt(length);
      tangents[index] = scale * alpha * slope;
      tangents[index + 1] = scale * beta * slope;
    }
  }
  let path = start;
  for (let index = 0; index < count - 1; index += 1) {
    const third = widths[index] / 3;
    path += ` C${round(xs[index] + third)},${round(ys[index] + tangents[index] * third)} ${round(xs[index + 1] - third)},${round(ys[index + 1] - tangents[index + 1] * third)} ${round(xs[index + 1])},${round(ys[index + 1])}`;
  }
  return path;
}

/** Label steps the value axis may take, finest first. */
const VALUE_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];

export interface ValueAxis {
  min: number;
  max: number;
  ticks: number[];
}

/**
 * A value axis fit to the values in view, as a stock chart rescales on zoom:
 * 5% headroom each side, never shorter than `minSpan` so a few points of
 * noise stay small, kept inside 0 to `ceiling`, and widened out to the
 * nearest label step that leaves at most `maxIntervals` gaps.
 */
export function valueAxis(
  values: number[],
  maxIntervals: number,
  ceiling = 1000,
  minSpan = 50,
): ValueAxis {
  let low = values.length ? Math.min(...values) : 0;
  let high = values.length ? Math.max(...values) : ceiling;
  const padding = (high - low) * 0.05;
  low -= padding;
  high += padding;
  if (high - low < minSpan) {
    const middle = (low + high) / 2;
    low = middle - minSpan / 2;
    high = middle + minSpan / 2;
  }
  if (high > ceiling) {
    low -= high - ceiling;
    high = ceiling;
  }
  if (low < 0) {
    high = Math.min(ceiling, high - low);
    low = 0;
  }
  const step =
    VALUE_STEPS.find(
      (candidate) =>
        Math.ceil(high / candidate) - Math.floor(low / candidate) <=
        Math.max(1, maxIntervals),
    ) ?? VALUE_STEPS[VALUE_STEPS.length - 1];
  const min = Math.max(0, Math.floor(low / step) * step);
  const max = Math.min(ceiling, Math.ceil(high / step) * step);
  const ticks: number[] = [];
  for (let tick = min; tick <= max; tick += step) ticks.push(tick);
  return { min, max, ticks };
}

export type TickUnit = "minute" | "hour" | "day" | "week" | "month" | "year";

export interface TimeTick {
  at: number;
  unit: TickUnit;
  /** The coarsest calendar period this tick also starts, in local time. */
  boundary: "day" | "month" | "year" | null;
}

/** Tick steps from finest to coarsest; months and years are approximate lengths. */
const TICK_STEPS: { unit: TickUnit; count: number; ms: number }[] = [
  ...[1, 2, 5, 10, 15, 30].map((count) => ({
    unit: "minute" as const,
    count,
    ms: count * MINUTE,
  })),
  ...[1, 2, 3, 6, 12].map((count) => ({
    unit: "hour" as const,
    count,
    ms: count * HOUR,
  })),
  ...[1, 2].map((count) => ({ unit: "day" as const, count, ms: count * DAY })),
  { unit: "week", count: 1, ms: 7 * DAY },
  ...[1, 2, 3, 6].map((count) => ({
    unit: "month" as const,
    count,
    ms: count * 30 * DAY,
  })),
  ...[1, 2, 5, 10].map((count) => ({
    unit: "year" as const,
    count,
    ms: count * 365 * DAY,
  })),
];

/** The first tick of a step at or before `at`, aligned to the local calendar. */
function alignTick(at: number, unit: TickUnit, count: number): Date {
  const date = new Date(at);
  const floor = (value: number) => Math.floor(value / count) * count;
  if (unit === "minute") {
    date.setSeconds(0, 0);
    date.setMinutes(floor(date.getMinutes()));
    return date;
  }
  date.setMinutes(0, 0, 0);
  if (unit === "hour") {
    date.setHours(floor(date.getHours()));
    return date;
  }
  date.setHours(0);
  if (unit === "day") date.setDate(floor(date.getDate() - 1) + 1);
  if (unit === "week") date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  if (unit === "month") date.setMonth(floor(date.getMonth()), 1);
  if (unit === "year") date.setFullYear(floor(date.getFullYear()), 0, 1);
  return date;
}

function advanceTick(date: Date, unit: TickUnit, count: number) {
  if (unit === "minute") date.setMinutes(date.getMinutes() + count);
  if (unit === "hour") date.setHours(date.getHours() + count);
  if (unit === "day") date.setDate(date.getDate() + count);
  if (unit === "week") date.setDate(date.getDate() + 7);
  if (unit === "month") date.setMonth(date.getMonth() + count);
  if (unit === "year") date.setFullYear(date.getFullYear() + count);
}

/** Each tick unit with the calendar boundaries coarser than it. */
const MAJOR_BOUNDARIES: Record<TickUnit, TimeTick["boundary"][]> = {
  minute: ["day", "month", "year"],
  hour: ["day", "month", "year"],
  day: ["month", "year"],
  week: ["month", "year"],
  month: ["year"],
  year: [],
};

/** A tick that starts a period coarser than its step: a new day among hours, a year among months. */
export function isMajorTick(tick: TimeTick): boolean {
  return MAJOR_BOUNDARIES[tick.unit].includes(tick.boundary);
}

function tickBoundary(date: Date): TimeTick["boundary"] {
  if (date.getHours() !== 0 || date.getMinutes() !== 0) return null;
  if (date.getDate() !== 1) return "day";
  return date.getMonth() === 0 ? "year" : "month";
}

/**
 * Calendar-aligned ticks in local time with the finest step that keeps at
 * most `maxCount` across the window: hours for a day, days for a week,
 * months for a year.
 */
export function timeTicks(view: TimeWindow, maxCount: number): TimeTick[] {
  const span = view.end - view.start;
  if (!(span > 0) || maxCount < 1) return [];
  const step =
    TICK_STEPS.find((candidate) => span / candidate.ms <= maxCount) ??
    TICK_STEPS[TICK_STEPS.length - 1];
  const ticks: TimeTick[] = [];
  const date = alignTick(view.start, step.unit, step.count);
  for (let guard = 0; guard < 1000 && date.getTime() <= view.end; guard += 1) {
    if (date.getTime() >= view.start)
      ticks.push({
        at: date.getTime(),
        unit: step.unit,
        boundary: tickBoundary(date),
      });
    advanceTick(date, step.unit, step.count);
  }
  return ticks;
}

/** The local offset from UTC as "+3", "−4:30" or "" in UTC itself. */
export function utcOffset(at: number): string {
  const minutes = -new Date(at).getTimezoneOffset();
  if (minutes === 0) return "";
  const sign = minutes > 0 ? "+" : "−";
  const hours = Math.floor(Math.abs(minutes) / 60);
  const rest = Math.abs(minutes) % 60;
  return `${sign}${hours}${rest ? `:${String(rest).padStart(2, "0")}` : ""}`;
}
