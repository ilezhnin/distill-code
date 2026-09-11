import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { SettingsView } from "../SettingsView";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(0.8),
}));

vi.mock("@/shared/api/acpConnection", () => ({}));

vi.mock("@/shared/profile/capabilities", () => ({
  useProfileCapability: () => true,
}));

vi.mock("../ProvidersSettings", () => ({
  ProvidersSettings: () => <div />,
}));

vi.mock("../ModelProviderRow", () => ({
  ModelProviderRow: () => <div />,
}));

vi.mock("../SecuritySettings", () => ({
  SecuritySettings: () => <div>security.title</div>,
}));

vi.mock("@/features/extensions/ui/ExtensionsSettings", () => ({
  ExtensionsSettings: () => <div>extensions.settings</div>,
}));

vi.mock("../StatsSettings", () => ({
  StatsSettings: () => <div>stats.title</div>,
}));

function renderSettingsView(
  activeSection: ComponentProps<
    typeof SettingsView
  >["activeSection"] = "security",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsView activeSection={activeSection} />
    </QueryClientProvider>,
  );
}

describe("SettingsView", () => {
  it("renders security settings", () => {
    renderSettingsView();

    expect(screen.getByText("security.title")).toBeInTheDocument();
  });

  it("renders extensions inside the shared settings pane", () => {
    renderSettingsView("extensions");

    expect(screen.getByText("extensions.settings")).toBeInTheDocument();
  });

  it("renders stats settings in the shared pane", () => {
    renderSettingsView("stats");

    expect(screen.getByText("stats.title")).toBeInTheDocument();
  });

  // BOT-1272: `connections` used to early-return its own `SettingsPane`, so
  // switching to/from it made the pane a different component type at the same
  // tree position. React unmounted and remounted the pane, replaying the
  // `page-transition` enter animation (opacity 0 -> 1) and flashing the
  // surface underneath. Every section must render into the same pane element
  // so section switches only swap the pane's children.
  it("keeps the same pane element when switching to and from extensions", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // `security` is a mocked section, so this asserts pane identity without
    // dragging in a real section's provider requirements.
    const { container, rerender } = render(
      <QueryClientProvider client={queryClient}>
        <SettingsView activeSection="security" />
      </QueryClientProvider>,
    );

    // Assert on ALL matches, not just the first: a nested second pane would
    // still animate on mount, and `querySelector` alone would not notice it.
    const panesOf = () =>
      Array.from(container.querySelectorAll(".page-transition"));
    const initialPanes = panesOf();
    expect(initialPanes).toHaveLength(1);
    const initialPane = initialPanes[0];

    rerender(
      <QueryClientProvider client={queryClient}>
        <SettingsView activeSection="extensions" />
      </QueryClientProvider>,
    );
    expect(screen.getByText("extensions.settings")).toBeInTheDocument();
    expect(panesOf()).toEqual([initialPane]);

    rerender(
      <QueryClientProvider client={queryClient}>
        <SettingsView activeSection="security" />
      </QueryClientProvider>,
    );
    expect(screen.getByText("security.title")).toBeInTheDocument();
    expect(panesOf()).toEqual([initialPane]);
  });
});
