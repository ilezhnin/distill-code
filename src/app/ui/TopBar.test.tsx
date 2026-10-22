import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";
import { TopBar } from "./TopBar";

describe("TopBar", () => {
  it("shows the product name when no view names the page", () => {
    renderWithProviders(<TopBar breadcrumbs={[]} />);
    expect(screen.getByTestId("app-top-bar-title")).toHaveTextContent(
      "Levocat Flock",
    );
  });

  it("prefers the chat title, then the last breadcrumb", () => {
    const { rerender } = renderWithProviders(
      <TopBar
        breadcrumbs={[
          { id: "chat", label: "Chat" },
          { id: "chat-session", label: "Fix the login flow" },
        ]}
      />,
    );
    expect(screen.getByTestId("app-top-bar-title")).toHaveTextContent(
      "Fix the login flow",
    );
    rerender(
      <TopBar
        breadcrumbs={[
          { id: "settings", label: "Settings" },
          { id: "settings-section", label: "Notifications" },
        ]}
      />,
    );
    expect(screen.getByTestId("app-top-bar-title")).toHaveTextContent(
      "Notifications",
    );
  });
});
