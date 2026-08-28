import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";

import { cn } from "@/shared/lib/cn";
import { SIDEBAR_GROUP_LABEL_TEXT_CLASS } from "@/shared/ui/sidebar-tokens";

import { buildAgentForest, countWorkingAgents } from "../agentTree";
import { useConductorGraphStore } from "../conductorGraphStore";
import { stopOrchestratorSession } from "../orchestratorControls";
import { AgentTreeView } from "./AgentTreeView";

/**
 * The project's live agents, in the sidebar, as a tree (P52).
 *
 * Until this existed, an agent was only visible from inside the conversation
 * that started it: the operator had to already know where to look to find out
 * that four workers were running. The sidebar is where they look for
 * everything else, so it is where "who is working for me right now" belongs —
 * and every row opens that agent's chat, subagents included, because the same
 * transparency rule applies at every depth.
 *
 * Live only. A finished agent is a chat, and chats are already listed below;
 * repeating every worker that ever ran would bury the project's own rows
 * under a transcript of the day.
 */
export function SidebarAgentsSection({
  projectId,
  activeSessionId,
  onSelectSession,
  className,
}: {
  projectId: string;
  activeSessionId?: string | null;
  onSelectSession?: (sessionId: string) => void;
  className?: string;
}) {
  const { t } = useTranslation("sidebar");
  const [collapsed, setCollapsed] = useState(false);
  // The node map itself is a stable reference the store only replaces when the
  // graph changes, so this subscription re-renders exactly as often as the
  // answer can change — and the forest is derived, not built in the selector.
  const nodesById = useConductorGraphStore((state) => state.nodesById);
  const forest = useMemo(
    () => buildAgentForest(nodesById, { projectId, include: "live" }),
    [nodesById, projectId],
  );
  const working = useMemo(() => countWorkingAgents(forest), [forest]);

  if (forest.length === 0) return null;

  return (
    <div className={cn("pb-1", className)} data-testid="sidebar-agents-section">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((current) => !current)}
        className={cn(
          "flex w-full items-center gap-1 rounded-sm py-1 pl-[26px] pr-3 text-left",
          SIDEBAR_GROUP_LABEL_TEXT_CLASS,
          "hover:text-sidebar-foreground",
        )}
      >
        {collapsed ? (
          <IconChevronRight className="size-3 shrink-0" aria-hidden="true" />
        ) : (
          <IconChevronDown className="size-3 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate">
          {t("agents.title", { count: working })}
        </span>
      </button>
      {collapsed ? null : (
        <AgentTreeView
          forest={forest}
          activeSessionId={activeSessionId}
          baseIndentPx={34}
          onOpen={(sessionId) => onSelectSession?.(sessionId)}
          onStop={(sessionId) => {
            void stopOrchestratorSession(sessionId);
          }}
        />
      )}
    </div>
  );
}
