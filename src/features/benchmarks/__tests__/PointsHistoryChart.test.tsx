import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/shared/i18n";
import {
  type HistoryPoint,
  POINT_GAP,
  PointsHistoryChart,
  placePoints,
} from "../ui/PointsHistoryChart";

const DAY = 86_400_000;
const start = Date.UTC(2026, 9, 1, 12);

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

function chart(points: HistoryPoint[]) {
  return render(
    <PointsHistoryChart
      points={points}
      selectedId={null}
      onSelect={() => {}}
    />,
  );
}

describe("points history placement", () => {
  it("keeps observations minutes apart separately clickable", () => {
    const placed = placePoints(
      [start, start + DAY, start + DAY + 120_000, start + 2 * DAY],
      64,
      592,
    );
    expect(placed[0]).toBe(64);
    expect(placed[3]).toBe(592);
    for (let index = 1; index < placed.length; index += 1)
      expect(placed[index] - placed[index - 1]).toBeGreaterThanOrEqual(
        POINT_GAP,
      );
  });

  it("pushes a crowded end back inside the plot", () => {
    const placed = placePoints([start, start + DAY, start + DAY + 1], 64, 592);
    expect(placed).toEqual([64, 592 - POINT_GAP, 592]);
  });

  it("spaces evenly when the width cannot hold every gap", () => {
    const times = Array.from({ length: 5 }, (_, index) => start + index);
    expect(placePoints(times, 0, 40)).toEqual([0, 10, 20, 30, 40]);
  });

  it("draws both markers apart and either one can be chosen", () => {
    const { container } = chart([
      point({ id: "run", at: start, points: 866 }),
      point({ id: "judged", at: start + 120_000, points: 870 }),
      point({ id: "later", at: start + 2 * DAY, points: 900 }),
    ]);
    const [run, judged] = [...container.querySelectorAll("circle")].map(
      (circle) => Number(circle.getAttribute("cx")),
    );
    expect(judged - run).toBeGreaterThanOrEqual(POINT_GAP);
  });
});

describe("points history labels", () => {
  afterEach(cleanup);

  it("labels points only and explains nothing until a held hover", () => {
    const { container } = chart([
      point({ id: "first", at: start, points: 1000 }),
      point({ id: "second", at: start + DAY, points: 957 }),
      point({ id: "third", at: start + 2 * DAY, points: 870 }),
    ]);
    const labels = [...container.querySelectorAll("svg text")].map(
      (text) => text.textContent,
    );
    expect(labels).toContain("870");
    expect(labels.some((label) => label?.includes("/"))).toBe(false);
    // Native SVG titles open instantly; explanations use the held tooltip.
    expect(container.querySelector("title")).toBeNull();
    expect(
      screen.getByLabelText("Overall points per measurement"),
    ).toBeInTheDocument();
  });

  it("counts later evidence with plural forms and leaves out zero counts", async () => {
    chart([
      point({ id: "first", at: start, points: 1000, backfilled: 1 }),
      point({ id: "second", at: start + DAY, points: 957, revised: 2 }),
    ]);
    const [first, second] = screen.getAllByRole("button");
    act(() => first.focus());
    expect(
      (await screen.findAllByText("1 case first measured later")).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/reviewed later/)).not.toBeInTheDocument();
    act(() => first.blur());
    await act(() => i18n.changeLanguage("es"));
    act(() => second.focus());
    expect(
      (await screen.findAllByText("2 casos revisados después")).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/0 casos/)).not.toBeInTheDocument();
  });
});
