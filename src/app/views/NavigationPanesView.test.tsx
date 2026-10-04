import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppView } from "@/app/AppShell";
import type { BenchmarkSection } from "@/features/benchmarks/lib/benchmarkNavigation";
import { NavigationPanesView } from "./NavigationPanesView";

vi.mock("@/features/providers/hooks/useAgentUpdatesAvailable", () => ({
  useAgentUpdatesAvailable: () => false,
}));

vi.mock("@/features/sessions/capabilities/SessionListCapability", () => ({
  SessionListCapability: () => null,
}));

function renderSidebar({
  activeView,
  activeBenchmarkSection = "leaderboard",
  onNavigate = vi.fn(),
  onBenchmarkSectionSelect = vi.fn(),
}: {
  activeView: AppView;
  activeBenchmarkSection?: BenchmarkSection;
  onNavigate?: (view: AppView) => void;
  onBenchmarkSectionSelect?: (section: BenchmarkSection) => void;
}) {
  const sidebar = (view: AppView, section: BenchmarkSection) => (
    <NavigationPanesView
      collapsed={false}
      width={240}
      activeView={view}
      activeBenchmarkSection={section}
      onNavigate={onNavigate}
      onBenchmarkSectionSelect={onBenchmarkSectionSelect}
      projects={[]}
    />
  );
  const result = render(sidebar(activeView, activeBenchmarkSection));
  return {
    ...result,
    show: (view: AppView, section: BenchmarkSection = activeBenchmarkSection) =>
      result.rerender(sidebar(view, section)),
  };
}

function mainNavigation() {
  return within(screen.getByRole("navigation", { name: "Main navigation" }));
}

const SECTION_LABELS = [
  "Leaderboard",
  "Design Bench",
  "Bench development",
  "Nerf Bench",
  "Usage Bench",
];

describe("NavigationPanesView benchmark sections", () => {
  it("lists the sections under Benchmarks while a benchmark page is open", () => {
    renderSidebar({ activeView: "benchmarks" });
    const nav = mainNavigation();
    const benchmarks = nav.getByRole("button", { name: "Benchmarks" });
    expect(benchmarks).toHaveAttribute("aria-expanded", "true");
    // The open section carries the highlight, like a project's chat does.
    expect(benchmarks).not.toHaveAttribute("aria-current");
    for (const label of SECTION_LABELS) {
      expect(nav.getByRole("button", { name: label })).toBeVisible();
    }
    expect(nav.getByRole("button", { name: "Leaderboard" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("opens Benchmarks from its row and a section from the list", async () => {
    const onNavigate = vi.fn();
    const onBenchmarkSectionSelect = vi.fn();
    const { show } = renderSidebar({
      activeView: "home",
      onNavigate,
      onBenchmarkSectionSelect,
    });
    await userEvent.click(
      mainNavigation().getByRole("button", { name: "Benchmarks" }),
    );
    expect(onNavigate).toHaveBeenCalledWith("benchmarks");

    show("benchmarks", "leaderboard");
    await userEvent.click(
      mainNavigation().getByRole("button", { name: "Nerf Bench" }),
    );
    expect(onBenchmarkSectionSelect).toHaveBeenCalledWith("nerf");

    show("benchmarks", "nerf");
    const nav = mainNavigation();
    expect(nav.getByRole("button", { name: "Nerf Bench" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      nav.getByRole("button", { name: "Leaderboard" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("closes the list once another destination is open", () => {
    const { show } = renderSidebar({ activeView: "benchmarks" });
    for (const view of [
      "home",
      "agents",
      "skills",
      "chat",
      "projects",
    ] as const) {
      show(view);
      const nav = mainNavigation();
      expect(nav.getByRole("button", { name: "Benchmarks" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      for (const label of SECTION_LABELS) {
        expect(
          nav.queryByRole("button", { name: label }),
        ).not.toBeInTheDocument();
      }
      show("benchmarks");
    }
  });

  it("does not leave the open section on ArrowLeft", () => {
    const onNavigate = vi.fn();
    renderSidebar({
      activeView: "benchmarks",
      activeBenchmarkSection: "usage",
      onNavigate,
    });
    const benchmarks = mainNavigation().getByRole("button", {
      name: "Benchmarks",
    });
    benchmarks.focus();
    fireEvent.keyDown(benchmarks, { key: "ArrowLeft" });
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.keyDown(benchmarks, { key: "ArrowDown" });
    expect(
      mainNavigation().getByRole("button", { name: "Leaderboard" }),
    ).toHaveFocus();
  });
});
