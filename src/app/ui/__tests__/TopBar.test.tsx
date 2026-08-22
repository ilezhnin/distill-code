import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/updates/ui/BetaBadge", () => ({
  BetaBadge: () => null,
}));

import { TopBar } from "../TopBar";

function renderTopBar(props: Partial<Parameters<typeof TopBar>[0]> = {}) {
  return render(
    <TopBar
      breadcrumbs={[{ label: "Home" }]}
      onFeedbackClick={vi.fn()}
      {...props}
    />,
  );
}

describe("TopBar", () => {
  it("shows the current view title after the navigation icons", () => {
    renderTopBar({ breadcrumbs: [{ id: "root", label: "Home" }] });

    expect(screen.getByTestId("app-top-bar-title")).toHaveTextContent("Home");
    expect(
      screen.queryByRole("button", { name: /Distill home/i }),
    ).not.toBeInTheDocument();
  });

  it("prefers the selected chat title over parent breadcrumbs", () => {
    renderTopBar({
      breadcrumbs: [
        { id: "chat", label: "Chat" },
        { id: "chat-session", label: "Conductor" },
      ],
    });

    expect(screen.getByTestId("app-top-bar-title")).toHaveTextContent(
      "Conductor",
    );
    expect(screen.queryByText("Chat")).not.toBeInTheDocument();
  });

  it("renders the skills title in the chat-title position", () => {
    renderTopBar({ breadcrumbs: [{ id: "skills", label: "Skills" }] });

    expect(screen.getByTestId("app-top-bar-title")).toHaveClass("truncate");
    expect(screen.getByTestId("app-top-bar-title")).toHaveTextContent("Skills");
  });

  it("omits search when onSearchClick is not provided", () => {
    renderTopBar();

    expect(
      screen.queryByRole("button", { name: /search/i }),
    ).not.toBeInTheDocument();
  });

  it("omits feedback when onFeedbackClick is not provided", () => {
    renderTopBar({ onFeedbackClick: undefined });

    expect(
      screen.queryByRole("button", { name: /feedback/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the agents page title in the chat-title position", () => {
    renderTopBar({ breadcrumbs: [{ id: "agents", label: "Agents" }] });

    expect(screen.getByTestId("app-top-bar-title")).toHaveClass(
      "text-[length:var(--text-app-top-bar-title)]",
      "font-normal",
    );
    expect(screen.getByTestId("app-top-bar-title")).toHaveTextContent("Agents");
  });

  it("keeps a long chat title in the flexible title slot after icons", () => {
    const { container } = renderTopBar({
      breadcrumbs: [
        {
          id: "chat-session",
          label: "A very long chat title that must truncate before controls",
        },
      ],
      onSearchClick: vi.fn(),
      rightRailLabel: "Details",
      showRightRailToggle: true,
    });

    const header = container.querySelector("header");
    const title = screen.getByTestId("app-top-bar-title");
    expect(header).toHaveClass("grid-cols-[minmax(0,1fr)_auto]");
    expect(title).toHaveClass("min-w-0", "truncate");
    expect(title).toHaveTextContent(
      "A very long chat title that must truncate before controls",
    );
  });

  it("keeps right-side toolbar controls available", () => {
    renderTopBar({
      rightRailLabel: "Details",
      onSearchClick: vi.fn(),
      showRightRailToggle: true,
    });

    expect(screen.getByRole("button", { name: /search/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /feedback/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /details/i })).toHaveAttribute(
      "data-right-rail-toggle",
      "true",
    );
  });
});
