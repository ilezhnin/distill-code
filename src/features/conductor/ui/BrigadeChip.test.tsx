import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BrigadeChip, type BrigadeChipViewModel } from "./BrigadeChip";

function viewModel(
  overrides: Partial<BrigadeChipViewModel> = {},
): BrigadeChipViewModel {
  return {
    id: "child-1",
    name: "Kepler",
    status: "running",
    ...overrides,
  };
}

describe("BrigadeChip", () => {
  it("renders a session-free view model with its name and status label", () => {
    render(<BrigadeChip {...viewModel()} />);

    const chip = screen.getByTestId("conductor-agent-chip");
    expect(chip).toHaveTextContent("Kepler");
    expect(chip).toHaveAttribute("aria-label", "Kepler, running");
    expect(chip).toHaveAttribute("title", "running");
    expect(screen.getByTestId("brigade-chip")).toHaveAttribute(
      "data-status",
      "running",
    );
  });

  it("prefers an explicit title over the status label", () => {
    render(<BrigadeChip {...viewModel({ title: "Draft the API surface" })} />);

    expect(screen.getByTestId("conductor-agent-chip")).toHaveAttribute(
      "title",
      "Draft the API surface",
    );
  });

  it("hands the id back to onOpen", () => {
    const onOpen = vi.fn();
    render(<BrigadeChip {...viewModel({ onOpen })} />);

    fireEvent.click(screen.getByTestId("conductor-agent-chip"));

    expect(onOpen).toHaveBeenCalledWith("child-1");
  });

  it("shows the stop button only while the chip is working", () => {
    const onStop = vi.fn();
    const { rerender } = render(<BrigadeChip {...viewModel({ onStop })} />);

    fireEvent.click(screen.getByTestId("conductor-agent-stop"));
    expect(onStop).toHaveBeenCalledWith("child-1");

    rerender(<BrigadeChip {...viewModel({ onStop, status: "completed" })} />);
    expect(screen.queryByTestId("conductor-agent-stop")).toBeNull();
  });

  it("omits the stop button when no onStop is given", () => {
    render(<BrigadeChip {...viewModel({ status: "waiting" })} />);

    expect(screen.queryByTestId("conductor-agent-stop")).toBeNull();
    expect(screen.getByTestId("conductor-agent-chip")).toBeInTheDocument();
  });

  it("stays inert when no onOpen is given", () => {
    render(<BrigadeChip {...viewModel({ status: "failed" })} />);

    // No handler wired: clicking must not throw.
    fireEvent.click(screen.getByTestId("conductor-agent-chip"));
    expect(screen.getByTestId("brigade-chip")).toHaveAttribute(
      "data-status",
      "failed",
    );
  });
});
