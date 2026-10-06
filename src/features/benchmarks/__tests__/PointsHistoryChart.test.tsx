import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { i18n } from "@/shared/i18n";
import {
  type HistoryPoint,
  PointsHistoryChart,
} from "../ui/PointsHistoryChart";

const DAY = 86_400_000;
const start = Date.UTC(2026, 6, 1, 12);

function point(
  overrides: Partial<HistoryPoint> & { id: string },
): HistoryPoint {
  return {
    at: start,
    points: 900,
    series: "same",
    scored: 23,
    planned: 66,
    ...overrides,
  };
}

function chart(points: HistoryPoint[], onSelect = vi.fn()) {
  const view = render(
    <PointsHistoryChart
      points={points}
      selectedId={null}
      onSelect={onSelect}
    />,
  );
  return { ...view, onSelect };
}

/** Fifty days of measurements every ten days, then two in the last week. */
const history = [
  ...Array.from({ length: 6 }, (_, index) =>
    point({
      id: `day-${index * 10}`,
      at: start + index * 10 * DAY,
      points: 500 + index * 50,
    }),
  ),
  point({ id: "recent", at: start + 61 * DAY, points: 870 }),
  point({ id: "latest", at: start + 64 * DAY, points: 880 }),
];

const shown = () =>
  screen
    .queryAllByRole("button", { name: /points ·/ })
    .map((marker) => marker.getAttribute("data-history-point"));
const marker = (id: string) =>
  document.querySelector(`[data-history-point="${id}"]`) as SVGCircleElement;
const markerX = (id: string) => Number(marker(id).getAttribute("cx"));
const markerY = (id: string) => Number(marker(id).getAttribute("cy"));
/** The value axis labels, the only plain numbers among the chart's texts. */
const valueLabels = (container: Element) =>
  [...container.querySelectorAll("svg text")]
    .map((text) => text.textContent ?? "")
    .filter((label) => /^\d+$/.test(label))
    .map(Number);
const pressed = () =>
  screen
    .queryAllByRole("button", { pressed: true })
    .filter((button) => button.tagName === "BUTTON")
    .map((button) => button.textContent);

// jsdom has no PointerEvent, so pointer events would arrive without coordinates.
const pointerEvent = window.PointerEvent;
beforeAll(() => {
  window.PointerEvent ??= class extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  } as typeof PointerEvent;
});
afterAll(() => {
  window.PointerEvent = pointerEvent;
});
afterEach(cleanup);

describe("points history zoom", () => {
  it("opens on the whole history and narrows to the chosen range", () => {
    chart(history);
    const max = screen.getByRole("button", { name: "All" });
    expect(max).toHaveAttribute("aria-pressed", "true");
    expect(shown()).toHaveLength(history.length);
    const week = screen.getByRole("button", { name: "1w" });
    fireEvent.click(week);
    expect(week).toHaveAttribute("aria-pressed", "true");
    expect(max).toHaveAttribute("aria-pressed", "false");
    expect(shown()).toEqual(["recent", "latest"]);
    fireEvent.click(screen.getByRole("button", { name: "1m" }));
    expect(shown()).toEqual(["day-40", "day-50", "recent", "latest"]);
  });

  it("treats a range longer than the history as all of it", () => {
    chart(history.slice(-2));
    fireEvent.click(screen.getByRole("button", { name: "1y" }));
    expect(screen.getByRole("button", { name: "1y" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(shown()).toEqual(["recent", "latest"]);
  });

  it("dates the axis by hours over a day and by days over months", () => {
    const labels = (container: HTMLElement) =>
      [...container.querySelectorAll("svg text")].map(
        (text) => text.textContent ?? "",
      );
    const long = chart(history);
    expect(labels(long.container).some((label) => /\d:\d\d/.test(label))).toBe(
      false,
    );
    long.unmount();
    const day = chart([
      point({ id: "morning", at: start, points: 900 }),
      point({ id: "next", at: start + 30 * 3_600_000, points: 910 }),
    ]);
    expect(labels(day.container).some((label) => /\d:\d\d/.test(label))).toBe(
      true,
    );
  });
});

describe("points history hover and selection", () => {
  it("snaps a band and a tooltip to the nearest measurement", () => {
    const { container } = chart([
      point({ id: "first", at: start, points: 1000 }),
      point({ id: "second", at: start + DAY, points: 957, scored: 40 }),
      point({ id: "third", at: start + 2 * DAY, points: 870 }),
    ]);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    const plot = container.querySelector("[data-history-plot]") as Element;
    fireEvent.pointerMove(plot, { clientX: markerX("second") + 5 });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("957");
    expect(tooltip).toHaveTextContent("40/66 cases");
    expect(tooltip).toHaveTextContent("UTC");
    expect(
      Number(container.querySelector("[data-history-band]")?.getAttribute("x")),
    ).toBeCloseTo(markerX("second") - 7);
    fireEvent.pointerLeave(plot);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("selects a clicked point, or the nearest one to a click on the plot", () => {
    const { container, onSelect } = chart([
      point({ id: "first", at: start }),
      point({ id: "second", at: start + DAY }),
      point({ id: "third", at: start + 2 * DAY }),
    ]);
    fireEvent.click(marker("third"));
    expect(onSelect).toHaveBeenLastCalledWith("third");
    fireEvent.click(container.querySelector("[data-history-plot]") as Element, {
      clientX: markerX("first") + 20,
    });
    expect(onSelect).toHaveBeenLastCalledWith("first");
  });

  it("emphasises the selected point and draws no native titles", () => {
    const { container } = render(
      <PointsHistoryChart
        points={[
          point({ id: "first", at: start }),
          point({ id: "second", at: start + DAY }),
        ]}
        selectedId="first"
        onSelect={() => {}}
      />,
    );
    expect(marker("first")).toHaveAttribute("aria-pressed", "true");
    expect(marker("second")).toHaveAttribute("aria-pressed", "false");
    expect(Number(marker("first").getAttribute("r"))).toBeGreaterThan(
      Number(marker("second").getAttribute("r")),
    );
    expect(container.querySelector("title")).toBeNull();
    expect(
      screen.getByLabelText("Overall points per measurement"),
    ).toBeInTheDocument();
  });

  it("marks where the pool was released inside the shown range", () => {
    const { container } = render(
      <PointsHistoryChart
        points={[
          point({ id: "before", at: start, series: "old" }),
          point({ id: "after", at: start + 2 * DAY, series: "new" }),
        ]}
        selectedId={null}
        onSelect={() => {}}
        releases={[
          { id: "r1", name: "v1", at: start + DAY },
          { id: "r0", name: "v0", at: start - 10 * DAY },
        ]}
      />,
    );
    const marks = container.querySelectorAll("[data-history-release]");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveAttribute("data-history-release", "v1");
    expect(marks[0]).toHaveTextContent("v1");
  });

  it("draws lines only between comparable measurements", () => {
    const { container } = chart([
      point({ id: "a", at: start }),
      point({ id: "b", at: start + DAY }),
      point({ id: "gap", at: start + 2 * DAY, points: null }),
      point({ id: "c", at: start + 3 * DAY }),
      point({ id: "d", at: start + 4 * DAY, series: "other" }),
      point({ id: "e", at: start + 5 * DAY, series: "other" }),
    ]);
    expect(container.querySelectorAll("[data-history-segment]")).toHaveLength(
      2,
    );
    expect(shown()).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("points history axes", () => {
  it("fits the value axis to the points drawn", () => {
    const { container } = chart([
      point({ id: "first", at: start, points: 1000 }),
      point({ id: "second", at: start + DAY, points: 990 }),
      point({ id: "third", at: start + 2 * DAY, points: 987 }),
    ]);
    // The 220px fallback plot holds three gaps between labels.
    expect(valueLabels(container)).toEqual([940, 960, 980, 1000]);
    // Thirteen points apart is a visible drop, not a hairline on 0 to 1000.
    expect(markerY("third") - markerY("first")).toBeGreaterThan(40);
    expect(markerY("second")).toBeLessThan(markerY("third"));
  });

  it("rescales to the zoomed range", () => {
    const { container } = chart(history);
    expect(valueLabels(container)).toEqual([400, 600, 800, 1000]);
    // The week's two points and the neighbour its line runs off toward.
    fireEvent.click(screen.getByRole("button", { name: "1w" }));
    expect(valueLabels(container)).toEqual([700, 800, 900]);
  });

  it("runs the grid, the series and the navigator edge to edge", () => {
    const { container } = chart(history);
    const grid = container.querySelector("[data-history-grid]") as Element;
    expect(Number(grid.getAttribute("x1"))).toBe(markerX("day-0"));
    expect(Number(grid.getAttribute("x2"))).toBe(markerX("latest"));
    const area = container
      .querySelector("[data-history-segment] path")
      ?.getAttribute("d") as string;
    expect(area.startsWith(`M${markerX("day-0")},`)).toBe(true);
    expect(area).toContain(`L${markerX("latest")},`);
    // At max the navigator window covers its whole track, half-pixel stroke aside.
    const track = container.querySelector("[data-navigator-track]") as Element;
    const range = container.querySelector(
      '[data-navigator="window"]',
    ) as Element;
    for (const name of ["x", "width"])
      expect(
        Math.abs(
          Number(track.getAttribute(name)) - Number(range.getAttribute(name)),
        ),
      ).toBeLessThanOrEqual(1);
  });
});

describe("points history keyboard", () => {
  it("keeps one tab stop, selects with Enter and walks with arrows", () => {
    const { onSelect } = chart([
      point({ id: "first", at: start }),
      point({ id: "second", at: start + DAY }),
      point({ id: "third", at: start + 2 * DAY }),
    ]);
    expect(
      ["first", "second", "third"].map((id) =>
        marker(id).getAttribute("tabindex"),
      ),
    ).toEqual(["-1", "-1", "0"]);
    act(() => marker("third").focus());
    fireEvent.keyDown(marker("third"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(marker("second"));
    // The tab stop moves with focus.
    expect(marker("second")).toHaveAttribute("tabindex", "0");
    expect(marker("third")).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tooltip")).toHaveTextContent("900");
    expect(marker("second")).toHaveAttribute(
      "aria-describedby",
      screen.getByRole("tooltip").id,
    );
    fireEvent.keyDown(marker("second"), { key: "Home" });
    expect(document.activeElement).toBe(marker("first"));
    fireEvent.keyDown(marker("first"), { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("first");
    fireEvent.keyDown(marker("first"), { key: "End" });
    expect(document.activeElement).toBe(marker("third"));
  });

  it("pans the window to a point reached past its edge", () => {
    chart(history);
    fireEvent.click(screen.getByRole("button", { name: "1w" }));
    act(() => marker("recent").focus());
    fireEvent.keyDown(marker("recent"), { key: "ArrowLeft" });
    expect(shown()).toContain("day-50");
    expect(document.activeElement).toBe(marker("day-50"));
    expect(screen.getByRole("button", { name: "1w" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("moves and resizes the navigator window with the keyboard", () => {
    chart(history);
    fireEvent.click(screen.getByRole("button", { name: "1w" }));
    const range = screen.getByRole("slider", { name: "Visible range" });
    fireEvent.keyDown(range, { key: "Home" });
    expect(shown()).toEqual(["day-0"]);
    fireEvent.keyDown(range, { key: "PageUp" });
    expect(shown()).toEqual(["day-10"]);
    expect(pressed()).toEqual([]);
    // Back at the newest end the window is a week again, and so is the button.
    fireEvent.keyDown(range, { key: "End" });
    expect(shown()).toEqual(["recent", "latest"]);
    expect(pressed()).toEqual(["1w"]);
    const startEdge = screen.getByRole("slider", {
      name: "Start of the visible range",
    });
    fireEvent.keyDown(startEdge, { key: "Home" });
    expect(shown()).toHaveLength(history.length);
    expect(pressed()).toEqual(["All"]);
  });

  it("leaves the pressed range alone when a key cannot move the window", () => {
    chart(history);
    const range = screen.getByRole("slider", { name: "Visible range" });
    for (const key of ["ArrowLeft", "End", "PageUp"]) {
      fireEvent.keyDown(range, { key });
      expect(pressed()).toEqual(["All"]);
    }
    // A longer range than the history stays the one chosen.
    cleanup();
    chart(history.slice(-2));
    fireEvent.click(screen.getByRole("button", { name: "1y" }));
    fireEvent.keyDown(screen.getByRole("slider", { name: "Visible range" }), {
      key: "ArrowLeft",
    });
    expect(pressed()).toEqual(["1y"]);
  });
});

describe("points history navigator", () => {
  it("drags the window and its edges, clamped to the history", () => {
    const { container } = chart(history);
    const part = (name: string) =>
      container.querySelector(`[data-navigator="${name}"]`) as Element;
    const left = Number(part("window").getAttribute("x"));
    const width = Number(part("window").getAttribute("width"));
    // Pull the start edge most of the way to the end.
    fireEvent.pointerDown(part("start"), { clientX: left, button: 0 });
    fireEvent.pointerMove(part("start"), { clientX: left + width * 0.9 });
    fireEvent.pointerUp(part("start"), { clientX: left + width * 0.9 });
    expect(shown()).toEqual(["recent", "latest"]);
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // Drag the narrowed window far past the start: it stops at the first point.
    const body = Number(part("window").getAttribute("x")) + 4;
    fireEvent.pointerDown(part("window"), { clientX: body, button: 0 });
    fireEvent.pointerMove(part("window"), { clientX: body - 5000 });
    fireEvent.pointerUp(part("window"), { clientX: body - 5000 });
    expect(Number(part("window").getAttribute("x"))).toBeCloseTo(left);
    expect(shown()[0]).toBe("day-0");
    expect(
      screen.getByRole("slider", { name: "Start of the visible range" }),
    ).toHaveAttribute("aria-valuenow", String(history[0].at));
    // Dragging the end handle out past the history shows all of it: max again.
    const end =
      Number(part("window").getAttribute("x")) +
      Number(part("window").getAttribute("width"));
    fireEvent.pointerDown(part("end"), { clientX: end, button: 0 });
    fireEvent.pointerMove(part("end"), { clientX: end + 5000 });
    fireEvent.pointerUp(part("end"), { clientX: end + 5000 });
    expect(shown()).toHaveLength(history.length);
    expect(pressed()).toEqual(["All"]);
  });

  it("centres the window on a press outside it", () => {
    const { container } = chart(history);
    fireEvent.click(screen.getByRole("button", { name: "1w" }));
    const background = container.querySelector(
      "[data-navigator-track]",
    ) as Element;
    const first = Number(
      container.querySelector('[data-navigator="window"]')?.getAttribute("x"),
    );
    // The fallback width maps the 64 days onto 12 to 596; press on day 10.
    const dayTen = 12 + (10 / 64) * 584;
    fireEvent.pointerDown(background, { clientX: dayTen, button: 0 });
    fireEvent.pointerUp(background, { clientX: dayTen });
    expect(
      Number(
        container.querySelector('[data-navigator="window"]')?.getAttribute("x"),
      ),
    ).toBeLessThan(first);
    expect(shown()).toEqual(["day-10"]);
  });

  it("is left out for a single measurement", () => {
    chart([point({ id: "only" })]);
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "All" }),
    ).not.toBeInTheDocument();
    expect(shown()).toEqual(["only"]);
  });
});

describe("points history labels", () => {
  it("counts later evidence with plural forms and leaves out zero counts", async () => {
    chart([
      point({ id: "first", at: start, points: 1000, backfilled: 1 }),
      point({ id: "second", at: start + DAY, points: 957, revised: 2 }),
    ]);
    act(() => marker("first").focus());
    const tooltip = screen.getByRole("tooltip");
    expect(
      within(tooltip).getByText("1 case first measured later"),
    ).toBeInTheDocument();
    expect(within(tooltip).queryByText(/reviewed later/)).toBeNull();
    act(() => marker("first").blur());
    await act(() => i18n.changeLanguage("es"));
    act(() => marker("second").focus());
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "2 casos revisados después",
    );
    expect(screen.getByRole("tooltip")).not.toHaveTextContent(/0 casos/);
    await act(() => i18n.changeLanguage("en"));
  });
});
