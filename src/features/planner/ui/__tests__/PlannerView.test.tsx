import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import { usePlannerStore } from "../../stores/plannerStore";
import { PlannerView } from "../PlannerView";

describe("PlannerView", () => {
  beforeEach(() => {
    window.localStorage.clear();
    usePlannerStore.getState().replaceAll([]);
  });

  it("names the page so the operator knows where they landed", () => {
    renderWithProviders(<PlannerView />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Planner" }),
    ).toBeInTheDocument();
  });

  it("says what the page is for", () => {
    renderWithProviders(<PlannerView />);

    expect(screen.getByTestId("planner-view")).toHaveTextContent(
      /what is due/i,
    );
  });

  it("hands the planning itself to the panel", () => {
    renderWithProviders(<PlannerView />);

    expect(screen.getByTestId("planner")).toBeInTheDocument();
    expect(screen.getByTestId("planner-tab-today")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
