import type { ComponentProps } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AppNavigationLocation } from "../types/appNavigation";

const pages = vi.hoisted(() => ({
  skills: vi.fn(),
  agents: vi.fn(),
  benchmarks: vi.fn(),
}));
const paints = vi.hoisted(() => ({
  jobs: [] as { run: () => void; cancel: ReturnType<typeof vi.fn> }[],
}));
vi.mock("../lib/scheduleAfterNextPaint", () => ({
  scheduleAfterNextPaint: (run: () => void) => {
    const cancel = vi.fn();
    paints.jobs.push({ run, cancel });
    return cancel;
  },
}));
vi.mock("@/features/skills/ui/SkillsView", () => ({
  SkillsView: (props: unknown) => {
    pages.skills(props);
    return <div>Skills</div>;
  },
}));
vi.mock("@/features/agents/ui/AgentsView", () => ({
  AgentsView: (props: unknown) => {
    pages.agents(props);
    return <div>Agents</div>;
  },
}));
vi.mock("@/features/benchmarks/ui/BenchmarksView", () => ({
  BenchmarksView: (props: unknown) => {
    pages.benchmarks(props);
    const { location } = props as { location: AppNavigationLocation };
    return <div data-testid="benchmarks-route">{JSON.stringify(location)}</div>;
  },
}));
import { AppShellContent } from "./AppShellContent";
import { useStagedAppContentLocation } from "../lib/useStagedAppContentLocation";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  paints.jobs.length = 0;
});

function StagedContent({ location }: { location: AppNavigationLocation }) {
  const staged = useStagedAppContentLocation(location);
  return <AppShellContent {...props} {...staged} />;
}

const modelPage = {
  view: "benchmarks",
  section: "leaderboard",
  configurationId: "model-1",
  benchmarkId: "test-1",
  runId: "run-1",
} satisfies AppNavigationLocation;

function expectVisibleRoute(
  container: HTMLElement,
  location: AppNavigationLocation,
) {
  expect(container.querySelector("[data-app-content-preparing]")).toBeNull();
  expect(container.querySelector("[inert]")).toBeNull();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  if (location.view === "benchmarks")
    expect(screen.getByTestId("benchmarks-route").textContent).toBe(
      JSON.stringify(location),
    );
}

it("shows evidence-only open, switch, close and history restoration without staging the page", () => {
  const view = render(<StagedContent location={modelPage} />);
  for (const attemptId of [
    "attempt-1",
    "attempt-2",
    undefined,
    "attempt-2",
    "attempt-1",
  ]) {
    const location = { ...modelPage, attemptId };
    view.rerender(<StagedContent location={location} />);
    expectVisibleRoute(view.container, location);
    // Paint stays delayed: the immediate modal route did not need a scheduler.
    expect(paints.jobs).toHaveLength(0);
  }
});

it.each([
  { ...modelPage, section: "development", attemptId: "attempt-2" },
  { ...modelPage, configurationId: "model-2", attemptId: "attempt-2" },
  { ...modelPage, benchmarkId: "test-2", attemptId: "attempt-2" },
  { ...modelPage, runId: "run-2", attemptId: "attempt-2" },
  { view: "skills", skillId: null },
] satisfies AppNavigationLocation[])("still stages a different page $view/$section/$configurationId/$benchmarkId/$runId", (target) => {
  const view = render(<StagedContent location={modelPage} />);
  view.rerender(<StagedContent location={target} />);
  expect(
    view.container.querySelector("[data-app-content-preparing]"),
  ).not.toBeNull();
  expect(
    screen.getByTestId("benchmarks-route").closest("[inert]"),
  ).not.toBeNull();
  expect(screen.getByTestId("benchmarks-route").textContent).toBe(
    JSON.stringify(modelPage),
  );
  const scheduled = [...paints.jobs];
  expect(scheduled.length).toBeGreaterThan(0);
  act(() => {
    for (const job of scheduled) job.run();
  });
  expectVisibleRoute(view.container, target);
});

it("cancels an outstanding page transition when returning to evidence and ignores its late callback", () => {
  const view = render(<StagedContent location={modelPage} />);
  view.rerender(
    <StagedContent location={{ ...modelPage, configurationId: "model-2" }} />,
  );
  const stale = [...paints.jobs];
  const evidence = { ...modelPage, attemptId: "attempt-1" };
  view.rerender(<StagedContent location={evidence} />);
  expectVisibleRoute(view.container, evidence);
  for (const job of stale) expect(job.cancel).toHaveBeenCalled();
  // A callback already handed to the event loop must not restore the other model.
  act(() => {
    for (const job of stale) job.run();
  });
  expectVisibleRoute(view.container, evidence);
  view.rerender(<StagedContent location={modelPage} />);
  act(() => {
    for (const job of stale) job.run();
  });
  expectVisibleRoute(view.container, modelPage);
});

it("keeps evidence on a not-yet-rendered model staged and discards its superseded destination", () => {
  const first = { ...modelPage, attemptId: "attempt-1" };
  const view = render(<StagedContent location={first} />);
  const nextPage = { ...modelPage, configurationId: "model-2" };
  view.rerender(<StagedContent location={nextPage} />);
  const stale = [...paints.jobs];
  const nextEvidence = { ...nextPage, attemptId: "attempt-2" };
  view.rerender(<StagedContent location={nextEvidence} />);
  const latest = paints.jobs.filter((job) => !stale.includes(job));
  for (const job of stale) expect(job.cancel).toHaveBeenCalled();
  act(() => {
    for (const job of stale) job.run();
  });
  expect(
    view.container.querySelector("[data-app-content-preparing]"),
  ).not.toBeNull();
  expect(screen.getByTestId("benchmarks-route").textContent).toBe(
    JSON.stringify(first),
  );
  expect(latest.length).toBeGreaterThan(0);
  act(() => {
    for (const job of latest) job.run();
  });
  expectVisibleRoute(view.container, nextEvidence);
});

const noop = () => {};
const props = {
  homeSessionId: null,
  onNavigateBenchmarks: noop,
  onNavigateSkills: noop,
  onNavigateAgents: noop,
  onCreatePersona: noop,
  onAgentBuilderCompleted: noop,
  onStartAgentBuilderSession: noop,
  onArchiveChat:
    vi.fn<ComponentProps<typeof AppShellContent>["onArchiveChat"]>(),
  onCreateProject: noop,
  onOpenProjectSettings: noop,
  onActivateHomeSession: noop,
  onRenameChat: noop,
  onSelectSession: noop,
  onSelectSearchResult: noop,
  onStartChatFromProject: noop,
  onStartChatWithSkill: noop,
  onExitSearch: noop,
  onOpenExtension: noop,
  onOpenAgent: noop,
  onOpenSkill: noop,
  onStartProviderTroubleshootingChat: noop,
};

it.each([
  { view: "skills", skillId: null },
  { view: "agents", personaId: null },
  { view: "benchmarks", section: "leaderboard" },
] satisfies AppNavigationLocation[])("does not rebuild the outgoing $view while staging navigation", (location) => {
  const renderedLocation: AppNavigationLocation = location;
  const page = pages[location.view as keyof typeof pages];
  const view = render(
    <AppShellContent
      {...props}
      renderedLocation={renderedLocation}
      targetLocation={renderedLocation}
      isPreparingContent={false}
    />,
  );
  expect(page).toHaveBeenCalledTimes(1);
  view.rerender(
    <AppShellContent
      {...props}
      renderedLocation={renderedLocation}
      targetLocation={{ view: "home" }}
      isPreparingContent
    />,
  );
  expect(page).toHaveBeenCalledTimes(1);
  const onSelectSession = vi.fn();
  view.rerender(
    <AppShellContent
      {...props}
      onSelectSession={onSelectSession}
      renderedLocation={renderedLocation}
      targetLocation={renderedLocation}
      isPreparingContent={false}
    />,
  );
  // Benchmark session links receive fresh handlers; memoization never ignores callbacks.
  if (location.view === "benchmarks") expect(page).toHaveBeenCalledTimes(2);
});
