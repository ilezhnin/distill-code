import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trustDomain } from "@/shared/lib/trustedDomains";
import { LinkifiedText } from "./LinkifiedText";

// A "user" bubble is not necessarily written by the local operator: another
// agent's `distillctl session send` and a conductor wave prompt both render here.
// So a bare URL in one gets the same confirmation an agent's Markdown link gets.
describe("LinkifiedText link safety", () => {
  beforeEach(() => {
    vi.mocked(openUrl).mockReset();
    vi.mocked(openUrl).mockResolvedValue(undefined);
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("asks before opening an untrusted url", async () => {
    const user = userEvent.setup();
    render(
      <LinkifiedText text="Check https://login-micros0ft.example/reset" />,
    );

    await user.click(
      screen.getByRole("link", {
        name: "https://login-micros0ft.example/reset",
      }),
    );

    const dialog = await screen.findByRole("dialog");
    // The dialog names the destination, so the operator sees what they are
    // about to open.
    expect(
      within(dialog).getByText("https://login-micros0ft.example/reset"),
    ).toBeInTheDocument();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("opens the url once the confirmation is accepted", async () => {
    const user = userEvent.setup();
    render(
      <LinkifiedText text="Check https://login-micros0ft.example/reset" />,
    );

    await user.click(
      screen.getByRole("link", {
        name: "https://login-micros0ft.example/reset",
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Open link" }));

    expect(openUrl).toHaveBeenCalledWith(
      "https://login-micros0ft.example/reset",
    );
  });

  it("opens a trusted domain without asking", async () => {
    const user = userEvent.setup();
    trustDomain("github.com");
    render(<LinkifiedText text="See https://github.com/distill/distill" />);

    await user.click(
      screen.getByRole("link", { name: "https://github.com/distill/distill" }),
    );

    expect(openUrl).toHaveBeenCalledWith("https://github.com/distill/distill");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
