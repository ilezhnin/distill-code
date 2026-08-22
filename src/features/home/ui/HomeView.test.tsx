import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HomeView } from "./HomeView";

describe("HomeView", () => {
  it("renders an empty work surface without the widget desktop", () => {
    render(<HomeView />);
    expect(screen.getByTestId("home-empty-panel")).toBeInTheDocument();
  });
});
