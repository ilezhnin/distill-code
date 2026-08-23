import { useTranslation } from "react-i18next";
import { IconCubePlus, IconEdit, IconPlus } from "@tabler/icons-react";
import type { AppView } from "@/app/AppShell";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { selectHasFetchedProjects } from "@/features/projects/stores/projectSelectors";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import type { FlatChatGroup } from "@/features/sidebar/lib/sidebarFlatChats";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { CollapseReveal } from "@/shared/ui/collapse-reveal";
import { DisclosureButton } from "@/shared/ui/disclosure-button";
import {
  SIDEBAR_GROUP_LABEL_TEXT_CLASS,
  SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS,
  SIDEBAR_ROW_HEIGHT_CLASS,
  SIDEBAR_ROW_HOVER_CLASS,
} from "@/shared/ui/sidebar-tokens";
import { SidebarChatDragProvider } from "./SidebarChatDragContext";
import {
  SIDEBAR_SECTION_HEADER_ACTION_REVEAL_CLASS,
  SidebarSectionHeader,
  SidebarSectionHeaderAction,
} from "./SidebarSectionHeader";
import { SidebarFlatChatsSection } from "./SidebarFlatChatsSection";
import { SidebarDisplayOptionsMenu } from "./SidebarDisplayOptionsMenu";
import { SidebarProjectList } from "./SidebarProjectList";
import {
  SidebarProjectsInfoButton,
  useSidebarProjectsInfoMoment,
} from "./SidebarProjectsInfoButton";
import type { SidebarSessionItem } from "./SidebarProjectSection";
import { SidebarRecentsSection } from "./SidebarRecentsSection";

export interface SidebarProjectsSectionProps {
  projects: ProjectInfo[];
  projectSessions: {
    byProject: Record<string, SidebarSessionItem[]>;
    standalone: SidebarSessionItem[];
    /** True when loaded standalone chats were truncated to the recents cap. */
    standaloneOverflow?: boolean;
  };
  hasVisibleChats: boolean;
  flatChatGroups: FlatChatGroup[];
  hasFlatChatOverflow: boolean;
  groupChatsByProject: boolean;
  onGroupChatsByProjectChange?: (grouped: boolean) => void;
  projectShowChatIcons: boolean;
  onProjectShowChatIconsChange: (show: boolean) => void;
  projectShowTimestamps: boolean;
  onProjectShowTimestampsChange: (show: boolean) => void;
  chatShowChatIcons: boolean;
  onChatShowChatIconsChange: (show: boolean) => void;
  chatShowTimestamps: boolean;
  onChatShowTimestampsChange: (show: boolean) => void;
  expandedProjects: Record<string, boolean>;
  toggleProject: (projectId: string) => void;
  collapsed: boolean;
  labelTransition: string;
  labelVisible: boolean;
  activeSessionId?: string | null;
  onNavigate?: (view: AppView) => void;
  onOpenProject?: (projectId: string) => void;
  onSelectSession?: (sessionId: string) => void;
  onNewChatInProject?: (projectId: string) => void;
  onNewConductorInProject?: (projectId: string) => void;
  onNewChat?: () => void;
  onCreateProject?: () => void;
  onEditProject?: (projectId: string) => void;
  onArchiveProject?: (projectId: string) => void;
  onArchiveChat?: (sessionId: string) => void | Promise<void>;
  onRenameChat?: (sessionId: string, nextTitle: string) => void;
  onForkChat?: (sessionId: string) => void;
  onMarkChatRead?: (sessionId: string) => void;
  onMarkChatUnread?: (sessionId: string) => void;
  onMoveToProject?: (sessionId: string, projectId: string | null) => void;
  selectedSessionIds?: Set<string>;
  selectionEnabled?: boolean;
  selectionActionsDisabled?: boolean;
  onSelectionClear?: () => void;
  onSelectionChange?: (sessionId: string, selected: boolean) => void;
  onRangeSelect?: (sessionId: string) => void;
  onArchiveSelected?: () => void;
  onOpenSelectedInWindows?: () => void;
  onMarkSelectedRead?: () => void;
  onMarkSelectedUnread?: () => void;
  onReorderProject?: (
    fromId: string,
    toId: string,
    placement?: "before" | "after",
  ) => void;
  hasMoreSessions?: boolean;
  projectsSectionOpen: boolean;
  recentsSectionOpen: boolean;
  onToggleProjectsSection: () => void;
  onToggleRecentsSection: () => void;
  showTopDivider?: boolean;
}

/** Typography only — color comes from the ghost+flush toggle Button so the
 * label and chevron always match at rest and on hover. */
const SECTION_HEADER_TEXT_CLASS = SIDEBAR_GROUP_LABEL_TEXT_CLASS;

export function SidebarProjectsSection({
  projects,
  projectSessions,
  hasVisibleChats,
  flatChatGroups,
  hasFlatChatOverflow,
  groupChatsByProject,
  onGroupChatsByProjectChange,
  projectShowChatIcons,
  onProjectShowChatIconsChange,
  projectShowTimestamps,
  onProjectShowTimestampsChange,
  chatShowChatIcons,
  onChatShowChatIconsChange,
  chatShowTimestamps,
  onChatShowTimestampsChange,
  expandedProjects,
  toggleProject,
  collapsed,
  labelTransition,
  labelVisible,
  activeSessionId,
  onNavigate,
  onSelectSession,
  onNewChatInProject,
  onNewConductorInProject,
  onNewChat,
  onCreateProject,
  onEditProject,
  onArchiveProject,
  onArchiveChat,
  onRenameChat,
  onForkChat,
  onMarkChatRead,
  onMarkChatUnread,
  onMoveToProject,
  selectedSessionIds,
  selectionEnabled = false,
  selectionActionsDisabled = false,
  onSelectionClear,
  onSelectionChange,
  onRangeSelect,
  onArchiveSelected,
  onOpenSelectedInWindows,
  onMarkSelectedRead,
  onMarkSelectedUnread,
  onReorderProject,
  hasMoreSessions = false,
  projectsSectionOpen,
  recentsSectionOpen,
  onToggleProjectsSection,
  onToggleRecentsSection,
  showTopDivider: _showTopDivider = true,
}: SidebarProjectsSectionProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const showProjectsEmptyState = projects.length === 0;
  const hasFetchedProjects = useProjectStore(selectHasFetchedProjects);
  const projectsInfoMoment = useSidebarProjectsInfoMoment({
    hasProjects: !showProjectsEmptyState,
    projectsReady: hasFetchedProjects,
  });
  const showChatsEmptyState = projectSessions.standalone.length === 0;
  const showCombinedEmptyState = showProjectsEmptyState && !hasVisibleChats;
  const showProjects = collapsed || projectsSectionOpen;
  // Only surface the Session History route when the grouped view actually
  // hides chats: loaded standalone chats were truncated to the recents cap,
  // or the backend has more sessions than are loaded. The hasMoreSessions
  // case is gated on having any loaded chats (not standalone ones
  // specifically): grouped auto-loading is bounded, so a user whose loaded
  // chats all belong to projects must still get a route to older sessions.
  // Brand-new users have no chats and no backend pages, so they never see
  // the link.
  const showGroupedHistoryLink =
    !collapsed &&
    ((projectSessions.standaloneOverflow ?? false) ||
      (hasMoreSessions && hasVisibleChats));
  const emptyActionClasses = cn(
    SIDEBAR_ROW_HEIGHT_CLASS,
    SIDEBAR_ROW_HOVER_CLASS,
    "w-full justify-start gap-2 text-sm text-muted-foreground",
    SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS,
  );

  if (!groupChatsByProject) {
    return (
      <>
        <SidebarFlatChatsSection
          groups={flatChatGroups}
          onGroupChatsByProjectChange={onGroupChatsByProjectChange}
          collapsed={collapsed}
          labelTransition={labelTransition}
          labelVisible={labelVisible}
          activeSessionId={activeSessionId}
          onNewChat={onNewChat}
          onCreateProject={onCreateProject}
          onNavigate={onNavigate}
          onEditProject={onEditProject}
          onSelectSession={onSelectSession}
          onArchiveChat={onArchiveChat}
          onRenameChat={onRenameChat}
          onForkChat={onForkChat}
          onMarkChatRead={onMarkChatRead}
          onMarkChatUnread={onMarkChatUnread}
          selectedSessionIds={selectedSessionIds}
          selectionEnabled={selectionEnabled}
          selectionActionsDisabled={selectionActionsDisabled}
          onSelectionClear={onSelectionClear}
          onSelectionChange={onSelectionChange}
          onRangeSelect={onRangeSelect}
          onArchiveSelected={onArchiveSelected}
          onOpenSelectedInWindows={onOpenSelectedInWindows}
          onMarkSelectedRead={onMarkSelectedRead}
          onMarkSelectedUnread={onMarkSelectedUnread}
          showTimestamps={chatShowTimestamps}
          onShowTimestampsChange={onChatShowTimestampsChange}
          showViewAllInHistory={hasFlatChatOverflow}
          showTopDivider={_showTopDivider}
        />
      </>
    );
  }

  return (
    <SidebarChatDragProvider>
      <div
        className={cn(
          "relative z-10",
          labelTransition,
          labelVisible
            ? "opacity-100 max-h-[2000px]"
            : collapsed
              ? "opacity-100 max-h-[2000px]"
              : "opacity-0 max-h-0 overflow-hidden",
        )}
      >
        <SidebarSectionHeader
          label={t("sections.projects")}
          collapsed={collapsed}
          labelTransition={labelTransition}
          labelVisible={labelVisible}
          onToggleOpen={onToggleProjectsSection}
          isOpen={projectsSectionOpen}
          showChevron={!showProjectsEmptyState}
          labelClassName={SECTION_HEADER_TEXT_CLASS}
          labelAdornment={
            projectsInfoMoment.visible ? (
              <SidebarProjectsInfoButton moment={projectsInfoMoment} />
            ) : undefined
          }
          actions={
            !showProjectsEmptyState ? (
              <>
                <SidebarDisplayOptionsMenu
                  labelKey="actions.projectDisplayOptions"
                  showChatIcons={projectShowChatIcons}
                  onShowChatIconsChange={onProjectShowChatIconsChange}
                  showTimestamps={projectShowTimestamps}
                  onShowTimestampsChange={onProjectShowTimestampsChange}
                  groupChatsByProject
                  onGroupChatsByProjectChange={onGroupChatsByProjectChange}
                  className={SIDEBAR_SECTION_HEADER_ACTION_REVEAL_CLASS}
                />
                <SidebarSectionHeaderAction
                  icon={IconPlus}
                  label={t("actions.newProject")}
                  onClick={onCreateProject}
                />
              </>
            ) : null
          }
        />

        <CollapseReveal open={showProjects}>
          <SidebarProjectList
            projects={projects}
            projectSessionsByProject={projectSessions.byProject}
            expandedProjects={expandedProjects}
            toggleProject={toggleProject}
            collapsed={collapsed}
            activeSessionId={activeSessionId}
            onNavigate={onNavigate}
            onSelectSession={onSelectSession}
            onNewChatInProject={onNewChatInProject}
            onNewConductorInProject={onNewConductorInProject}
            onEditProject={onEditProject}
            onArchiveProject={onArchiveProject}
            onArchiveChat={onArchiveChat}
            onRenameChat={onRenameChat}
            onForkChat={onForkChat}
            onMarkChatRead={onMarkChatRead}
            onMarkChatUnread={onMarkChatUnread}
            onMoveToProject={onMoveToProject}
            selectedSessionIds={selectedSessionIds}
            selectionEnabled={selectionEnabled}
            selectionActionsDisabled={selectionActionsDisabled}
            onSelectionClear={onSelectionClear}
            onSelectionChange={onSelectionChange}
            onRangeSelect={onRangeSelect}
            onArchiveSelected={onArchiveSelected}
            onOpenSelectedInWindows={onOpenSelectedInWindows}
            onMarkSelectedRead={onMarkSelectedRead}
            onMarkSelectedUnread={onMarkSelectedUnread}
            showChatIcons={projectShowChatIcons}
            showTimestamps={projectShowTimestamps}
            onReorderProject={onReorderProject}
            hasMoreSessions={hasMoreSessions}
            dropTargetsEnabled={showProjects}
          />
        </CollapseReveal>

        {showProjectsEmptyState &&
          (collapsed ? (
            <div className="flex flex-col items-center gap-0">
              <Button
                type="button"
                variant="ghost"
                flush
                size="icon-xs"
                onClick={onCreateProject}
                aria-label={t("empty.createProject")}
                tooltip={t("empty.createProject")}
                className="rounded-lg"
              >
                <IconCubePlus className="size-4" />
              </Button>
            </div>
          ) : (
            <div className="space-y-0">
              <Button
                type="button"
                variant="ghost"
                flush
                size="xs"
                onClick={onCreateProject}
                className={emptyActionClasses}
                leftIcon={<IconCubePlus className="size-3.5" />}
              >
                {t("empty.createProject")}
              </Button>
            </div>
          ))}

        {showCombinedEmptyState && collapsed ? (
          <div className="flex flex-col items-center gap-0">
            <Button
              type="button"
              variant="ghost"
              flush
              size="icon-xs"
              onClick={onNewChat}
              aria-label={t("empty.startChat")}
              tooltip={t("empty.startChat")}
              className="rounded-lg"
            >
              <IconEdit className="size-4" />
            </Button>
          </div>
        ) : showCombinedEmptyState ? (
          <>
            <SidebarSectionHeader
              label={t("sections.recents")}
              collapsed={collapsed}
              labelTransition={labelTransition}
              labelVisible={labelVisible}
              labelClassName={SECTION_HEADER_TEXT_CLASS}
            />
            <div className="space-y-0">
              <Button
                type="button"
                variant="ghost"
                flush
                size="xs"
                onClick={onNewChat}
                className={emptyActionClasses}
                leftIcon={<IconEdit className="size-4" />}
              >
                {t("empty.startChat")}
              </Button>
            </div>
          </>
        ) : (
          <SidebarRecentsSection
            sessions={projectSessions.standalone}
            collapsed={collapsed}
            labelTransition={labelTransition}
            labelVisible={labelVisible}
            showEmptyState={showChatsEmptyState}
            activeSessionId={activeSessionId}
            onNewChat={onNewChat}
            onNavigate={onNavigate}
            onSelectSession={onSelectSession}
            onArchiveChat={onArchiveChat}
            onRenameChat={onRenameChat}
            onForkChat={onForkChat}
            onMarkChatRead={onMarkChatRead}
            onMarkChatUnread={onMarkChatUnread}
            onMoveToProject={onMoveToProject}
            selectedSessionIds={selectedSessionIds}
            selectionEnabled={selectionEnabled}
            selectionActionsDisabled={selectionActionsDisabled}
            onSelectionClear={onSelectionClear}
            onSelectionChange={onSelectionChange}
            onRangeSelect={onRangeSelect}
            onArchiveSelected={onArchiveSelected}
            onOpenSelectedInWindows={onOpenSelectedInWindows}
            onMarkSelectedRead={onMarkSelectedRead}
            onMarkSelectedUnread={onMarkSelectedUnread}
            showChatIcons={chatShowChatIcons}
            onShowChatIconsChange={onChatShowChatIconsChange}
            showTimestamps={chatShowTimestamps}
            onShowTimestampsChange={onChatShowTimestampsChange}
            isOpen={recentsSectionOpen}
            onToggleOpen={onToggleRecentsSection}
            sectionHeaderTextClass={SECTION_HEADER_TEXT_CLASS}
          />
        )}
        {showGroupedHistoryLink && onNavigate ? (
          <DisclosureButton
            type="button"
            surface="sidebarRow"
            onClick={() => onNavigate("session-history")}
            className={cn(
              "h-7 w-full justify-start rounded-sm px-3 py-1 text-sm",
              SIDEBAR_GROUP_LABEL_TEXT_CLASS,
            )}
          >
            {t("viewAllInHistory")}
          </DisclosureButton>
        ) : null}
      </div>
    </SidebarChatDragProvider>
  );
}
