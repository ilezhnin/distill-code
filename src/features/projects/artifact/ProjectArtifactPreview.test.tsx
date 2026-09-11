import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProjectArtifactPreview } from "./ProjectArtifactPreview";

describe("ProjectArtifactPreview", () => {
  it("shows the project glyph on its accent glow", () => {
    const { container } = render(
      <ProjectArtifactPreview input={{ name: "Launch plan" }} />,
    );

    expect(screen.getByTestId("project-artifact-preview")).toBeInTheDocument();
    expect(
      screen.getByTestId("project-artifact-placeholder-glyph"),
    ).toBeInTheDocument();
    expect(container.querySelector(".backdrop-blur-xl")).toBeInTheDocument();
  });

  it("shows a project glyph placeholder in the tile variant", () => {
    const { container } = render(
      <ProjectArtifactPreview input={{ name: "Launch plan" }} variant="tile" />,
    );

    expect(
      container.querySelector(".backdrop-blur-xl"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("project-artifact-placeholder-glyph"),
    ).toBeInTheDocument();
  });
});
