import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockOpenSessionDeepLink = vi.fn<(href: string) => Promise<boolean>>();

vi.mock("@/features/sessions/lib/openSessionDeepLink", () => ({
  openSessionDeepLink: mockOpenSessionDeepLink,
}));

import { MessageResponse } from "./message";

// `flock` is the scheme this build creates; `distill` is the scheme of the
// links earlier builds wrote into transcripts, which are not rewritten.
const SESSION_LINK_SCHEMES = ["flock", "distill"] as const;

describe("MessageResponse Flock session Markdown links", () => {
  beforeEach(() => {
    mockOpenSessionDeepLink.mockReset();
    mockOpenSessionDeepLink.mockResolvedValue(true);
  });

  describe.each(SESSION_LINK_SCHEMES)("%s: links", (scheme) => {
    it("preserves encoded session ids as one deep-link path segment", () => {
      const href = `${scheme}://session/id%2Fwith%20spaces%3F%23%25%E2%9C%93`;

      render(
        <MessageResponse mode="static">
          {`Open [encoded](${href}).`}
        </MessageResponse>,
      );

      expect(screen.getByRole("link", { name: "encoded" })).toHaveAttribute(
        "href",
        href,
      );
    });

    it.each([
      ["double-slash", `${scheme}://session/session-1`],
      ["triple-slash", `${scheme}:///session/session-1`],
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
      const forgedHref = `/__flock_session_link__/${encodeURIComponent(
        `${scheme}://session/session-1`,
      )}`;

      render(
        <MessageResponse mode="static">{`Do not open [this](${forgedHref}).`}</MessageResponse>,
      );

      expect(screen.queryByRole("link", { name: "this" })).toBeNull();
      expect(screen.getByText(/this \[blocked\]/)).toBeInTheDocument();
    });

    it.each([
      `${scheme}://connect-return`,
      `${scheme}:/session/session-1`,
      `${scheme}:session/session-1`,
      `${scheme}://session/`,
      `${scheme}:///session/`,
      `${scheme}://session/a/b`,
      `${scheme}://session/a//b`,
      `${scheme}://session/%FF`,
      `${scheme}://SESSION/session-1`,
    ])("keeps malformed or non-session link %s blocked", (href) => {
      render(
        <MessageResponse mode="static">{`Do not open [this](${href}).`}</MessageResponse>,
      );

      expect(screen.queryByRole("link", { name: "this" })).toBeNull();
      expect(screen.getByText(/this \[blocked\]/)).toBeInTheDocument();
    });
  });
});
