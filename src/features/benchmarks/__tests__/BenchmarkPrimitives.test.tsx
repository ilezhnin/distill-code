import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ModelIdentity } from "../ui/BenchmarkPrimitives";
import { configuration } from "./fixtures";

afterEach(cleanup);

describe("ModelIdentity", () => {
  const identity = (effort: string | null) =>
    render(
      <ModelIdentity
        configuration={{ ...configuration, effort }}
        name="Claude Sonnet"
        vendor="Anthropic"
      />,
    );

  it("names every explicit effort level as a chip", () => {
    for (const effort of ["minimal", "low", "high", "max", "xhigh"]) {
      identity(effort);
      expect(screen.getByText(effort)).toBeInTheDocument();
      cleanup();
    }
  });

  it("never names the CLI's default as an effort", () => {
    identity("default");
    expect(screen.getByText("Claude Sonnet")).toBeInTheDocument();
    expect(screen.queryByText("default")).toBeNull();
  });

  it("shows no effort chip for a model without an effort control", () => {
    const { container } = identity(null);
    expect(screen.getByText("Claude Sonnet")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="badge"]')).toHaveLength(0);
  });
});
