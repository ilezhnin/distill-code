import type { SectionId } from "@/features/settings/ui/settingsSections";
import type { DesignSystemSection } from "@/features/design-system/ui/designSystemSections";

export type AppView =
  | "home"
  | "chat"
  | "design-system"
  | "skills"
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
  | { view: "agents"; personaId: string | null }
  | { view: "projects" }
  | { view: "search" }
  | { view: "session-history" }
  | { view: "settings"; settingsSection: SectionId };

export type AppNavigationUpdateOptions = {
  replace?: boolean;
};
