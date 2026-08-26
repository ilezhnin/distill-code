import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  startOfLocalDay,
  type PlannerTask,
} from "@/features/planner/lib/plannerTask";
import { usePlannerStore } from "@/features/planner/stores/plannerStore";
import { SETTINGS_SECTIONS } from "@/features/settings/ui/settingsSections";
import { renderWithProviders } from "@/test/render";

import { PrimaryNavigationSurface } from "../PrimaryNavigationSurface";

const NO_MASK = {} as const;

function task(overrides: Partial<PlannerTask> = {}): PlannerTask {
  const now = Date.now();
  return {
    id: overrides.id ?? "t-1",
    title: "A task",
    createdAt: now,
    dueAt: null,
    completedAt: null,
    priority: "normal",
    repeat: null,
    ...overrides,
  };
}

function renderSurface(overrides: Record<string, unknown> = {}) {
  const onNavigate = vi.fn();
  renderWithProviders(
    <PrimaryNavigationSurface
      activeView="home"
      agentUpdatesAvailable={false}
      bottomMaskStyle={NO_MASK}
      topMaskStyle={NO_MASK}
      bothEdgeMaskStyle={NO_MASK}
      isSecondarySurface={false}
      labelTransition="none"
      mainNavRef={null}
      navCollapsed={false}
      navLabelVisible
      onKeyDown={() => {}}
      onNavigate={onNavigate}
      secondaryNavRef={null}
      settingsSections={SETTINGS_SECTIONS}
      showBottomMask={false}
      showTopMask={false}
      showAutomationsSurface={false}
      showBuilderbotSurface={false}
      showSecondaryBottomMask={false}
      width={240}
      {...overrides}
    />,
  );
  return { onNavigate };
}

describe("primary navigation planner slot", () => {
  beforeEach(() => {
    window.localStorage.clear();
    usePlannerStore.getState().replaceAll([]);
  });

  it("offers planning as its own destination, right after Home", () => {
    renderSurface();

    const home = screen.getByTestId("nav-home");
    const planner = screen.getByTestId("nav-planner");
    expect(planner).toBeInTheDocument();
    expect(
      home.compareDocumentPosition(planner) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("navigates to the planner when the slot is clicked", async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderSurface();

    await user.click(screen.getByTestId("nav-planner"));

    expect(onNavigate).toHaveBeenCalledWith("planner");
  });

  it("stays quiet when nothing is due", () => {
    usePlannerStore.getState().replaceAll([
      task({
        dueAt: startOfLocalDay(Date.now()).valueOf() + 30 * 24 * 60 * 60 * 1000,
      }),
    ]);
    renderSurface();

    expect(screen.queryByTestId("nav-planner-count")).not.toBeInTheDocument();
  });

  it("counts what the operator owes today", () => {
    usePlannerStore.getState().replaceAll([
      task({ id: "a", dueAt: startOfLocalDay(Date.now()).valueOf() }),
      task({
        id: "b",
        dueAt: startOfLocalDay(Date.now()).valueOf() - 24 * 60 * 60 * 1000,
      }),
    ]);
    renderSurface();

    expect(screen.getByTestId("nav-planner-count")).toHaveTextContent("2");
  });
});
