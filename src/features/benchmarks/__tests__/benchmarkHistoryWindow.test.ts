import { describe, expect, it, vi } from "vitest";
import {
  centerWindow,
  clampWindow,
  isMajorTick,
  MIN_WINDOW_MS,
  matchingRange,
  nearestIndex,
  POINT_GAP,
  panWindow,
  placePoints,
  resizeWindow,
  revealTime,
  smoothPath,
  type TimeTick,
  timeTicks,
  utcOffset,
  valueAxis,
  windowFor,
} from "../lib/benchmarkHistoryWindow";
import { rollingBand } from "../lib/benchmarkHistoryWindow";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const start = Date.UTC(2026, 0, 1, 12);
const year = { start, end: start + 400 * DAY };

describe("zoom windows", () => {
  it("ends every range at the newest measurement", () => {
    expect(windowFor("1w", year)).toEqual({
      start: year.end - 7 * DAY,
      end: year.end,
    });
  });

  it("counts months on the calendar", () => {
    const month = windowFor("1m", year);
    const from = new Date(month.start);
    const to = new Date(month.end);
    expect(month.end).toBe(year.end);
    expect((to.getMonth() - from.getMonth() + 12) % 12).toBe(1);
    expect(from.getDate()).toBe(to.getDate());
    const twelve = windowFor("1y", year);
    expect(new Date(twelve.start).getFullYear()).toBe(to.getFullYear() - 1);
  });

  it("shows the whole history for max and for a range longer than it", () => {
    const short = { start, end: start + 2 * DAY };
    expect(windowFor("max", year)).toEqual(year);
    expect(windowFor("1w", short)).toEqual(short);
    expect(windowFor("1y", short)).toEqual(short);
  });
});

describe("range matching", () => {
  it("names the range a window shows, max first for the whole history", () => {
    expect(matchingRange(year, year)).toBe("max");
    expect(matchingRange(windowFor("1w", year), year)).toBe("1w");
    expect(matchingRange(windowFor("6m", year), year)).toBe("6m");
    // Every range longer than a short history shows it whole; that is max.
    const short = { start, end: start + 2 * DAY };
    expect(matchingRange(short, short)).toBe("max");
  });

  it("matches within the tolerance and nothing off the newest end", () => {
    const week = windowFor("1w", year);
    expect(matchingRange({ ...week, start: week.start + 1000 }, year)).toBe(
      null,
    );
    expect(
      matchingRange({ ...week, start: week.start + 1000 }, year, 1000),
    ).toBe("1w");
    expect(
      matchingRange({ start: week.start - DAY, end: week.end - DAY }, year),
    ).toBe(null);
    expect(matchingRange({ ...year, end: year.end - DAY }, year)).toBe(null);
  });
});

describe("navigator window", () => {
  const view = { start: start + 10 * DAY, end: start + 20 * DAY };

  it("pans without leaving the history or changing width", () => {
    expect(panWindow(view, -30 * DAY, year)).toEqual({
      start,
      end: start + 10 * DAY,
    });
    expect(panWindow(view, 1000 * DAY, year)).toEqual({
      start: year.end - 10 * DAY,
      end: year.end,
    });
    expect(panWindow(view, DAY, year)).toEqual({
      start: view.start + DAY,
      end: view.end + DAY,
    });
  });

  it("resizes one edge, never past the other or the history", () => {
    expect(resizeWindow(view, "start", start - DAY, year)).toEqual({
      start,
      end: view.end,
    });
    expect(resizeWindow(view, "start", view.end + DAY, year)).toEqual({
      start: view.end - MIN_WINDOW_MS,
      end: view.end,
    });
    expect(resizeWindow(view, "end", view.start, year)).toEqual({
      start: view.start,
      end: view.start + MIN_WINDOW_MS,
    });
    expect(resizeWindow(view, "end", year.end + DAY, year)).toEqual({
      start: view.start,
      end: year.end,
    });
  });

  it("keeps the minimum width within a history shorter than it", () => {
    const tiny = { start, end: start + 10 * 60_000 };
    expect(resizeWindow(tiny, "start", tiny.end, tiny)).toEqual(tiny);
    expect(clampWindow({ start, end: start + 1 }, tiny)).toEqual(tiny);
  });

  it("widens a window narrower than the minimum and pulls it inside", () => {
    expect(clampWindow({ start: year.end, end: year.end }, year)).toEqual({
      start: year.end - MIN_WINDOW_MS,
      end: year.end,
    });
  });

  it("centres on a press and reveals a time just outside", () => {
    expect(centerWindow(view, start + 50 * DAY, year)).toEqual({
      start: start + 45 * DAY,
      end: start + 55 * DAY,
    });
    expect(centerWindow(view, start, year)).toEqual({
      start,
      end: start + 10 * DAY,
    });
    expect(revealTime(view, start + 25 * DAY, year)).toEqual({
      start: start + 15 * DAY,
      end: start + 25 * DAY,
    });
    expect(revealTime(view, start + 5 * DAY, year)).toEqual({
      start: start + 5 * DAY,
      end: start + 15 * DAY,
    });
    expect(revealTime(view, start + 12 * DAY, year)).toBe(view);
  });
});

describe("nearest point", () => {
  it("snaps to the closest position from anywhere", () => {
    const positions = [10, 50, 200];
    expect(nearestIndex(positions, -100)).toBe(0);
    expect(nearestIndex(positions, 29)).toBe(0);
    expect(nearestIndex(positions, 31)).toBe(1);
    expect(nearestIndex(positions, 130)).toBe(2);
    expect(nearestIndex(positions, 5000)).toBe(2);
    expect(nearestIndex(positions, 30)).toBe(0);
    expect(nearestIndex([], 30)).toBe(-1);
  });
});

describe("point placement", () => {
  const span = (from: number, to: number) => ({ start: from, end: to });

  it("keeps observations minutes apart separately clickable", () => {
    const times = [start, start + DAY, start + DAY + 120_000, start + 2 * DAY];
    const placed = placePoints(times, span(start, start + 2 * DAY), 64, 592);
    expect(placed[0]).toBe(64);
    expect(placed[3]).toBe(592);
    for (let index = 1; index < placed.length; index += 1)
      expect(placed[index] - placed[index - 1]).toBeGreaterThanOrEqual(
        POINT_GAP,
      );
  });

  it("pushes a crowded end back inside the plot", () => {
    const times = [start, start + DAY, start + DAY + 1];
    expect(placePoints(times, span(start, start + DAY + 1), 64, 592)).toEqual([
      64,
      592 - POINT_GAP,
      592,
    ]);
  });

  it("spaces evenly when the width cannot hold every gap", () => {
    const times = Array.from({ length: 5 }, (_, index) => start + index);
    expect(placePoints(times, span(start, start + 4), 0, 40)).toEqual([
      0, 10, 20, 30, 40,
    ]);
  });

  it("keeps neighbours outside the window in proportion", () => {
    const times = [start - DAY, start, start + DAY, start + 3 * DAY];
    expect(placePoints(times, span(start, start + 2 * DAY), 0, 200)).toEqual([
      -100, 0, 100, 300,
    ]);
  });
});

describe("value axis", () => {
  const gaps = (ticks: number[]) =>
    ticks.slice(1).map((tick, index) => tick - ticks[index]);

  it("fits measurements near the top instead of a flat line on 0 to 1000", () => {
    expect(valueAxis([987, 1000, 993], 5)).toEqual({
      min: 950,
      max: 1000,
      ticks: [950, 960, 970, 980, 990, 1000],
    });
  });

  it("keeps headroom, even steps and the label budget", () => {
    for (const values of [
      [300, 900],
      [512, 518],
      [0, 40],
      [120, 980, 640],
    ]) {
      const axis = valueAxis(values, 4);
      expect(axis.min).toBeLessThanOrEqual(Math.min(...values));
      expect(axis.max).toBeGreaterThanOrEqual(Math.max(...values));
      expect(axis.min).toBeGreaterThanOrEqual(0);
      expect(axis.max).toBeLessThanOrEqual(1000);
      expect(axis.max - axis.min).toBeGreaterThanOrEqual(50);
      expect(axis.ticks[0]).toBe(axis.min);
      expect(axis.ticks.at(-1)).toBe(axis.max);
      expect(axis.ticks.length - 1).toBeLessThanOrEqual(4);
      expect(new Set(gaps(axis.ticks)).size).toBe(1);
    }
    // Values clear of both ends get room above and below.
    const middle = valueAxis([300, 900], 4);
    expect(middle.min).toBeLessThan(300);
    expect(middle.max).toBeGreaterThan(900);
  });

  it("stays inside the scale at its ends and for no values", () => {
    expect(valueAxis([1000, 1000], 5)).toMatchObject({ min: 950, max: 1000 });
    expect(valueAxis([0], 5)).toMatchObject({ min: 0, max: 50 });
    expect(valueAxis([0, 1000], 5)).toMatchObject({ min: 0, max: 1000 });
    expect(valueAxis([], 4)).toEqual({
      min: 0,
      max: 1000,
      ticks: [0, 250, 500, 750, 1000],
    });
  });
});

describe("date ticks", () => {
  it("steps by hours over a day, days over a month, months over a year", () => {
    const day = timeTicks({ start, end: start + DAY }, 10);
    expect(day.length).toBeGreaterThan(2);
    expect(day.every((tick) => tick.unit === "hour")).toBe(true);
    const month = timeTicks({ start, end: start + 30 * DAY }, 10);
    expect(month.every((tick) => ["day", "week"].includes(tick.unit))).toBe(
      true,
    );
    const twelve = timeTicks({ start, end: start + 365 * DAY }, 10);
    expect(twelve.every((tick) => tick.unit === "month")).toBe(true);
  });

  it("stays inside the window, under the count and on calendar lines", () => {
    for (const span of [HOUR, DAY, 9 * DAY, 120 * DAY, 3000 * DAY]) {
      const view = { start: start + 17 * 60_000, end: start + span };
      const ticks = timeTicks(view, 8);
      expect(ticks.length).toBeLessThanOrEqual(9);
      expect(ticks.length).toBeGreaterThan(0);
      for (const [index, tick] of ticks.entries()) {
        expect(tick.at).toBeGreaterThanOrEqual(view.start);
        expect(tick.at).toBeLessThanOrEqual(view.end);
        if (index) expect(tick.at).toBeGreaterThan(ticks[index - 1].at);
        const date = new Date(tick.at);
        expect(date.getSeconds()).toBe(0);
        if (tick.unit !== "minute") expect(date.getMinutes()).toBe(0);
        if (["day", "week", "month", "year"].includes(tick.unit))
          expect(date.getHours()).toBe(0);
        if (tick.unit === "month") expect(date.getDate()).toBe(1);
      }
    }
  });

  it("marks the ticks that start a day", () => {
    const ticks = timeTicks({ start, end: start + 2 * DAY }, 16);
    const midnights = ticks.filter((tick) => tick.boundary !== null);
    expect(midnights.length).toBeGreaterThanOrEqual(1);
    for (const tick of midnights) expect(new Date(tick.at).getHours()).toBe(0);
  });

  it("emphasises only a boundary coarser than the step", () => {
    const tick = (
      unit: TimeTick["unit"],
      boundary: TimeTick["boundary"],
    ): TimeTick => ({ at: start, unit, boundary });
    expect(isMajorTick(tick("hour", "day"))).toBe(true);
    expect(isMajorTick(tick("minute", "month"))).toBe(true);
    expect(isMajorTick(tick("hour", null))).toBe(false);
    expect(isMajorTick(tick("day", "day"))).toBe(false);
    expect(isMajorTick(tick("day", "month"))).toBe(true);
    expect(isMajorTick(tick("week", "year"))).toBe(true);
    expect(isMajorTick(tick("month", "month"))).toBe(false);
    expect(isMajorTick(tick("month", "year"))).toBe(true);
    expect(isMajorTick(tick("year", "year"))).toBe(false);
  });

  it("emphasises year starts among months and month starts among days", () => {
    const months = timeTicks({ start, end: start + 3 * 365 * DAY }, 12);
    expect(months.every((tick) => tick.unit === "month")).toBe(true);
    const major = months.filter(isMajorTick);
    expect(major.length).toBeGreaterThan(0);
    expect(major.length).toBeLessThan(months.length);
    for (const tick of major) expect(new Date(tick.at).getMonth()).toBe(0);
    const days = timeTicks({ start, end: start + 40 * DAY }, 60);
    expect(days.every((tick) => tick.unit === "day")).toBe(true);
    expect(
      days.filter(isMajorTick).map((tick) => new Date(tick.at).getDate()),
    ).toEqual([1]);
  });

  it("returns none for an empty window", () => {
    expect(timeTicks({ start, end: start }, 8)).toEqual([]);
  });
});

describe("smooth line", () => {
  it("never overshoots the values it joins", () => {
    const xs = [0, 10, 20, 60, 80];
    const ys = [100, 20, 20, 90, 0];
    const path = smoothPath(xs, ys);
    const controls = [...path.matchAll(/C([^ ]+) ([^ ]+) ([^ ]+)/g)];
    expect(controls).toHaveLength(4);
    controls.forEach((match, index) => {
      const low = Math.min(ys[index], ys[index + 1]);
      const high = Math.max(ys[index], ys[index + 1]);
      for (const point of [match[1], match[2]]) {
        const y = Number(point.split(",")[1]);
        expect(y).toBeGreaterThanOrEqual(low);
        expect(y).toBeLessThanOrEqual(high);
      }
    });
  });

  it("draws a dot as a move and two points as a line", () => {
    expect(smoothPath([5], [7])).toBe("M5,7");
    expect(smoothPath([0, 10], [0, 5])).toBe("M0,0 L10,5");
  });
});

describe("local offset", () => {
  it("reads the zone's distance from UTC", () => {
    const offset = vi.spyOn(Date.prototype, "getTimezoneOffset");
    offset.mockReturnValue(-180);
    expect(utcOffset(start)).toBe("+3");
    offset.mockReturnValue(270);
    expect(utcOffset(start)).toBe("−4:30");
    offset.mockReturnValue(0);
    expect(utcOffset(start)).toBe("");
  });
});

describe("rollingBand", () => {
  const point = (id: string, points: number | null) => ({ id, points });

  it("follows the model's own recent median and flags points outside its band", () => {
    const band = rollingBand([
      point("a", 1000),
      point("b", 992),
      point("c", 1038),
      point("d", 942),
      point("e", 880),
      point("f", 1000),
    ]);
    // The median of a, b, c is 1000; d is still inside 900 to 1100.
    expect(band.get("c")).toMatchObject({ median: 1000, outside: null });
    expect(band.get("d")?.outside).toBeNull();
    // e: the median of a to e is 992, and 880 sits below 892.8.
    expect(band.get("e")).toMatchObject({ median: 992, outside: "below" });
    // The window slides: f reads against b to f.
    expect(band.get("f")?.median).toBe(992);
    expect(band.get("f")?.outside).toBeNull();
  });

  it("skips gaps and widens with the tolerance", () => {
    const band = rollingBand(
      [point("a", 500), point("gap", null), point("b", 600)],
      5,
      0.25,
    );
    expect(band.has("gap")).toBe(false);
    expect(band.get("b")).toMatchObject({
      median: 550,
      low: 412.5,
      high: 687.5,
      outside: null,
    });
  });
});
