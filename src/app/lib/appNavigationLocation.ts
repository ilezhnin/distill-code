import type { DesignSystemSection } from "@/features/design-system/ui/designSystemSections";
import type { SectionId } from "@/features/settings/ui/settingsSections";
import type { AppNavigationLocation, AppView } from "../types/appNavigation";

export function getAppNavigationLocation(
  view: AppView,
  sessionId: string | null,
  settingsSection: SectionId,
  skillsSkillId: string | null,
  agentsPersonaId: string | null,
  designSystemSection: DesignSystemSection,
): AppNavigationLocation {
  switch (view) {
    case "chat":
      return { view, sessionId };
    case "design-system":
      return { view, designSystemSection };
    case "skills":
      return { view, skillId: skillsSkillId };
    case "agents":
      return { view, personaId: agentsPersonaId };
    case "settings":
      return { view, settingsSection };
    case "home":
    case "projects":
    case "search":
    case "session-history":
      return { view };
  }
}

export function areAppNavigationLocationsEqual(
  a: AppNavigationLocation | undefined,
  b: AppNavigationLocation,
) {
  return JSON.stringify(a) === JSON.stringify(b);
}
