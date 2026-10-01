import type { SectionId } from "@/features/settings/ui/settingsSections";
import type { DesignSystemSection } from "@/features/design-system/ui/designSystemSections";
import type { BenchmarkLocation } from "@/features/benchmarks/lib/benchmarkNavigation";

export type AppView =
  | "home"
  | "chat"
  | "design-system"
  | "skills"
  | "benchmarks"
  | "agents"
  | "projects"
  | "search"
  | "session-history"
  | "settings";

export type AppNavigationLocation =
  | { view: "home" }
  | { view: "chat"; sessionId: string | null }
  | { view: "design-system"; designSystemSection: DesignSystemSection }
  | { view: "skills"; skillId: string | null }
  | ({ view: "benchmarks" } & BenchmarkLocation)
  | { view: "agents"; personaId: string | null }
  | { view: "projects" }
  | { view: "search" }
  | { view: "session-history" }
  | { view: "settings"; settingsSection: SectionId };

export type AppNavigationUpdateOptions = {
  replace?: boolean;
};
