import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Checkbox } from "./checkbox";

describe("Checkbox", () => {
  it("marks a partial selection with a dash, never a check", () => {
    render(<Checkbox aria-label="All" checked="indeterminate" />);
    const box = screen.getByRole("checkbox", { name: "All" });
    expect(box).toHaveAttribute("data-state", "indeterminate");
    expect(box.querySelector(".lucide-minus")).not.toBeNull();
    expect(box.querySelector(".lucide-check")).toBeNull();
  });

  it("marks a full selection with a check", () => {
    render(<Checkbox aria-label="One" checked />);
    const box = screen.getByRole("checkbox", { name: "One" });
    expect(box.querySelector(".lucide-check")).not.toBeNull();
  });
});
