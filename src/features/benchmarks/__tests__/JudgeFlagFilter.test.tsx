import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JudgeFlagFilter } from "../ui/JudgeFlagFilter";

afterEach(cleanup);

describe("judge flag filter", () => {
  it("shows every score by default and hides a chosen mark", async () => {
    const onChange = vi.fn();
    render(<JudgeFlagFilter hidden={[]} onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "Judges" });
    expect(trigger).toHaveTextContent("All");
    await userEvent.click(trigger);
    const lab = await screen.findByRole("menuitemcheckbox", {
      name: "A judge from the model's own lab",
    });
    expect(lab).toHaveAttribute("aria-checked", "true");
    await userEvent.click(lab);
    expect(onChange).toHaveBeenLastCalledWith(["sameVendor"]);
  });

  it("counts hidden marks and shows one again", async () => {
    const onChange = vi.fn();
    render(
      <JudgeFlagFilter
        hidden={["sameVendor", "authorModel"]}
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Judges" });
    expect(trigger).toHaveTextContent("2 hidden");
    await userEvent.click(trigger);
    const author = await screen.findByRole("menuitemcheckbox", {
      name: "The case author's model on the panel",
    });
    expect(author).toHaveAttribute("aria-checked", "false");
    await userEvent.click(author);
    expect(onChange).toHaveBeenLastCalledWith(["sameVendor"]);
  });
});
