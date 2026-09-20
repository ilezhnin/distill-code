import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockOpenSessionDeepLink = vi.fn<(href: string) => Promise<boolean>>();

vi.mock("@/features/sessions/lib/openSessionDeepLink", () => ({
  openSessionDeepLink: mockOpenSessionDeepLink,
}));

import { MessageResponse } from "./message";

describe("MessageResponse Distill session Markdown links", () => {
  beforeEach(() => {
    mockOpenSessionDeepLink.mockReset();
    mockOpenSessionDeepLink.mockResolvedValue(true);
  });

  it("renders valid distill session deep links as links", () => {
    render(
      <MessageResponse mode="static">
        {"Open [the session](distill://session/session-1)."}
      </MessageResponse>,
    );

    expect(screen.getByRole("link", { name: "the session" })).toHaveAttribute(
      "href",
      "distill://session/session-1",
    );
    expect(screen.queryByText("[blocked]", { exact: false })).toBeNull();
  });

  it("preserves encoded session ids as one deep-link path segment", () => {
    render(
      <MessageResponse mode="static">
        {
          "Open [encoded](distill://session/id%2Fwith%20spaces%3F%23%25%E2%9C%93)."
        }
      </MessageResponse>,
    );

    expect(screen.getByRole("link", { name: "encoded" })).toHaveAttribute(
      "href",
      "distill://session/id%2Fwith%20spaces%3F%23%25%E2%9C%93",
    );
  });

  it.each([
    ["double-slash", "distill://session/session-1"],
    ["triple-slash", "distill:///session/session-1"],
  ])("routes %s clicks through the session deep-link opener", async (_, href) => {
    const user = userEvent.setup();
    render(
      <MessageResponse mode="static">
        {`Open [the session](${href}).`}
      </MessageResponse>,
    );

    await user.click(screen.getByRole("link", { name: "the session" }));

    await waitFor(() => {
      expect(mockOpenSessionDeepLink).toHaveBeenCalledWith(href);
    });
  });

  it("keeps forged session-link restore prefixes blocked", () => {
    const forgedHref =
      "/__distill_session_link__/distill%3A%2F%2Fsession%2Fsession-1";

    render(
      <MessageResponse mode="static">{`Do not open [this](${forgedHref}).`}</MessageResponse>,
    );

    expect(screen.queryByRole("link", { name: "this" })).toBeNull();
    expect(screen.getByText(/this \[blocked\]/)).toBeInTheDocument();
  });

  it.each([
    "distill://connect-return",
    "distill:/session/session-1",
    "distill:session/session-1",
    "distill://session/",
    "distill:///session/",
    "distill://session/a/b",
    "distill://session/a//b",
    "distill://session/%FF",
    "distill://SESSION/session-1",
  ])("keeps malformed or non-session distill link %s blocked", (href) => {
    render(
      <MessageResponse mode="static">{`Do not open [this](${href}).`}</MessageResponse>,
    );

    expect(screen.queryByRole("link", { name: "this" })).toBeNull();
    expect(screen.getByText(/this \[blocked\]/)).toBeInTheDocument();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "vbscript:msgbox(1)",
  ])("continues blocking unsafe scheme %s", (href) => {
    render(
      <MessageResponse mode="static">{`Do not open [this](${href}).`}</MessageResponse>,
    );

    expect(screen.queryByRole("link", { name: "this" })).toBeNull();
    expect(screen.getByText(/this \[blocked\]/)).toBeInTheDocument();
  });
});
