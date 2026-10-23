import type { ComponentProps } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AppNavigationLocation } from "../types/appNavigation";

const pages = vi.hoisted(() => ({
  skills: vi.fn(),
  agents: vi.fn(),
  benchmarks: vi.fn(),
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
    return <div>Benchmarks</div>;
  },
}));
import { AppShellContent } from "./AppShellContent";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
