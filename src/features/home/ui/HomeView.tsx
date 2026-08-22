import type { SkillInfo } from "@/features/skills/api/skills";

export interface HomeViewProps {
  onOpenProject?: (projectId: string) => void;
  onOpenSkill?: (skill: SkillInfo) => void;
  onOpenAgent?: (agentId: string) => void;
  onTagAgentInComposer?: (agentId: string) => void;
  onTagProjectInComposer?: (projectId: string) => void;
  onTagSkillInComposer?: (skill: SkillInfo) => void;
  onSelectSession?: (sessionId: string) => void;
  onStartProjectChat?: (projectId: string) => void;
  onOpenAutomation?: (automationId: string) => void;
  onCreatePersona?: () => void;
  onCreateProject?: () => void;
  onOpenSkills?: () => void;
  onOpenAutomations?: () => void;
  onResolveBerdyAgent?: () => Promise<string | null>;
  onHydratePinnedChatSessions?: (sessionIds: string[]) => void;
  viewportLeftOcclusionPx?: number;
}

export function HomeView(_props: HomeViewProps) {
  return <div className="h-full w-full" data-testid="home-empty-panel" />;
}
