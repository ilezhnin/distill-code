import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LocalMarkdownLinkProvider } from "./local-link-context";
import { MessageResponse } from "./message";

describe("MessageResponse local Markdown links", () => {
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
});
