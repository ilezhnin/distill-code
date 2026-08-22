import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BerdLoaderInline } from "@/shared/ui/berd-loader-inline";

describe("BerdLoaderInline", () => {
  it("plays the frame animation when animated", () => {
    const { container } = render(<BerdLoaderInline animated />);
    const mark = container.querySelector('[data-slot="berd-loader-inline"]');

    expect(mark).toHaveAttribute("data-animated", "true");
    expect((mark as HTMLElement).style.animation).toContain(
      "distill-loader-frames",
    );
  });

  it("renders no animation when static", () => {
    const { container } = render(<BerdLoaderInline animated={false} />);
    const mark = container.querySelector('[data-slot="berd-loader-inline"]');

    expect(mark).toHaveAttribute("data-animated", "false");
    expect((mark as HTMLElement).style.animation).toBe("");
  });

  it("is hidden from assistive tech when decorative", () => {
    const { container } = render(<BerdLoaderInline decorative />);
    const mark = container.querySelector('[data-slot="berd-loader-inline"]');

    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark).not.toHaveAttribute("aria-label");
  });

  it("exposes a loading label when not decorative", () => {
    const { container } = render(<BerdLoaderInline />);
    const mark = container.querySelector('[data-slot="berd-loader-inline"]');

    expect(mark).toHaveAttribute("role", "img");
    expect(mark).toHaveAttribute("aria-label", "Loading");
  });
});
