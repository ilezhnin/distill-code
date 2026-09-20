import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LocalMarkdownLinkProvider } from "./local-link-context";
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
    "/__distill_local_path__/data%3Atext%2Fhtml%2Chello",
    "/__distill_local_path__/java%0Ascript%3Aalert(1)",
    "/__distill_local_path__/%00javascript%3Aalert(1)",
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

describe("MessageResponse local Markdown link clicks", () => {
  // The opener plugin's global click listener hands any `target="_blank"`
  // anchor whose resolved href is http(s) to the OS browser. A local path
  // resolves against the app origin, so an anchor that keeps harden's
  // `_blank` and is not defaultPrevented opens a dead
  // `http://tauri.localhost/<path>` tab.
  it.each([
    "report.md",
    "./report.md",
    "docs/report.md",
    "/abs/report.md",
  ])("does not mark the local link %s as a new-window target", (path) => {
    render(
      <MessageResponse mode="static">
        {`Open the [report](${path}).`}
      </MessageResponse>,
    );

    const link = screen.getByRole("link", { name: "report" });
    expect(link).not.toHaveAttribute("target");
  });

  it("keeps target=_blank on an external link", () => {
    render(
      <MessageResponse mode="static">
        {"Open [example](https://example.com/report.md)."}
      </MessageResponse>,
    );

    expect(screen.getByRole("link", { name: "example" })).toHaveAttribute(
      "target",
      "_blank",
    );
  });

  it.each([
    "report.md",
    "./report.md",
    "/abs/report.md",
  ])("cancels the click on the local link %s and routes it to the surface's opener", async (path) => {
    const opened: string[] = [];
    render(
      <LocalMarkdownLinkProvider value={(href) => opened.push(href)}>
        <MessageResponse mode="static">
          {`Open the [report](${path}).`}
        </MessageResponse>
      </LocalMarkdownLinkProvider>,
    );

    const link = screen.getByRole("link", { name: "report" });
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(opened).toEqual([path]);
  });

  it("cancels the click even when no surface provides an opener", () => {
    render(
      <MessageResponse mode="static">
        {"Open the [report](report.md)."}
      </MessageResponse>,
    );

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    screen.getByRole("link", { name: "report" }).dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("does not route an external link to the local opener", () => {
    const opened: string[] = [];
    render(
      <LocalMarkdownLinkProvider value={(href) => opened.push(href)}>
        <MessageResponse mode="static">
          {"Open [example](https://example.com/report.md)."}
        </MessageResponse>
      </LocalMarkdownLinkProvider>,
    );

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    screen.getByRole("link", { name: "example" }).dispatchEvent(event);

    expect(opened).toEqual([]);
  });
});
