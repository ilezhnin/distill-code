import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BerdLoader } from "@/shared/ui/berd-loader";

describe("BerdLoader", () => {
  it("plays the frame animation when animated", () => {
    const { container } = render(<BerdLoader animated />);
    const mark = container.querySelector('[data-slot="berd-loader"]');

    expect(mark).toHaveAttribute("data-animated", "true");
    expect((mark as HTMLElement).style.animation).toContain(
      "distill-loader-frames",
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders the first frame when static", () => {
    const { container } = render(<BerdLoader animated={false} />);
    const mark = container.querySelector('[data-slot="berd-loader"]');

    expect(mark).toHaveAttribute("data-animated", "false");
    expect((mark as HTMLElement).style.animation).toBe("");
  });
});
