import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type MarkdownImageRenderer, MessageResponse } from "./message";

describe("MessageResponse local Markdown links", () => {
  it("preserves a bare relative filesystem path as a link", () => {
    render(
      <MessageResponse mode="static">
        {"Open the [research page](wiki/research/blockplat-compose.md)."}
      </MessageResponse>,
    );

    expect(screen.getByRole("link", { name: "research page" })).toHaveAttribute(
      "href",
      "wiki/research/blockplat-compose.md",
    );
    expect(screen.queryByText("[blocked]", { exact: false })).toBeNull();
  });

  it("preserves percent-encoded bare relative paths for artifact resolution", () => {
    render(
      <MessageResponse mode="static">
        {"Open the [research page](wiki/research/my%20report.md)."}
      </MessageResponse>,
    );

    expect(screen.getByRole("link", { name: "research page" })).toHaveAttribute(
      "href",
      "wiki/research/my%20report.md",
    );
  });

  it.each([
    ["./report.md", "dot"],
    ["../report.md", "dotdot"],
    ["./out/nested/report.md", "nested"],
    ["../../other/report.md", "double"],
  ])("keeps the dot-relative path %s intact instead of rewriting it to a root path", (path, label) => {
    render(
      <MessageResponse mode="static">
        {`Open the [${label}](${path}).`}
      </MessageResponse>,
    );

    const link = screen.getByRole("link", { name: label });
    expect(link).toHaveAttribute("href", path);
    expect(screen.queryByText("[blocked]", { exact: false })).toBeNull();
  });

  it.each([
    "./photo.png",
    "../out/diagram.png",
    "photo.png",
    "out/diagram.png",
  ])("hands the image renderer the relative src %s unchanged", (src) => {
    const seen: string[] = [];
    const imageRenderer: MarkdownImageRenderer = ({ node: _node, ...rest }) => {
      seen.push(String(rest.src));
      return <img alt={rest.alt ?? ""} src={rest.src} />;
    };

    render(
      <MessageResponse imageRenderer={imageRenderer} mode="static">
        {`Look: ![picture](${src})`}
      </MessageResponse>,
    );

    expect(seen).toEqual([src]);
  });

  it.each([
    "C:/repo/wiki/report.md",
    "C:\\repo\\wiki\\report.md",
  ])("keeps the absolute Windows path %s as a link", (path) => {
    render(
      <MessageResponse mode="static">
        {`Open the [report](${path}).`}
      </MessageResponse>,
    );

    // Markdown percent-encodes the backslashes; the path itself survives.
    const link = screen.getByRole("link", { name: "report" });
    expect(decodeURIComponent(link.getAttribute("href") ?? "")).toBe(path);
    expect(screen.queryByText("[blocked]", { exact: false })).toBeNull();
  });

  it("still blocks unsafe link schemes", () => {
    render(
      <MessageResponse mode="static">
        {"Do not open [this](javascript:alert(1))."}
      </MessageResponse>,
    );

    expect(screen.queryByRole("link", { name: "this" })).toBeNull();
    expect(screen.getByText(/this \[blocked\]/)).toBeInTheDocument();
  });

  it.each([
    "/__berd_local_path__/data%3Atext%2Fhtml%2Chello",
    "/__berd_local_path__/java%0Ascript%3Aalert(1)",
    "/__berd_local_path__/%00javascript%3Aalert(1)",
  ])("does not decode forged local-path sentinel %s", (forgedSentinel) => {
    render(
      <MessageResponse mode="static">
        {`Open [this](${forgedSentinel}).`}
      </MessageResponse>,
    );

    expect(screen.getByRole("link", { name: "this" })).toHaveAttribute(
      "href",
      forgedSentinel,
    );
  });
});
