import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconGitBranch,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  getDisplaySessionTitle,
  getEditableSessionTitle,
  isSessionTitleUnchanged,
} from "@/features/chat/lib/sessionTitle";
import { exportSessionAction } from "@/features/sessions/lib/exportSessionAction";
import {
  isMultiSelectModifier,
  isRangeSelectModifier,
} from "@/features/sessions/lib/sessionSelection";
import {
  SessionActionsContextMenuContent,
  SessionActionsMenuContent,
} from "@/features/sessions/ui/SessionActionsMenuItems";
import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";
import {
  clearPointerDragClickSuppression,
  hasExceededPointerDragThreshold,
  isPrimaryPointerButton,
  schedulePointerDragClickSuppressionReset,
} from "@/features/sidebar/lib/pointerDrag";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
  SIDEBAR_NAV_TEXT_CLASS,
  SIDEBAR_ROW_ACTIVE_CLASS,
  SIDEBAR_ROW_HEIGHT_CLASS,
  SIDEBAR_ROW_HOVER_CLASS,
  SIDEBAR_ROW_SHELL_ACTIVE_CLASS,
  SIDEBAR_ROW_SHELL_HOVER_CLASS,
  SIDEBAR_ROW_TEXT_DEFAULT_CLASS,
  SIDEBAR_ROW_VERTICAL_PADDING_CLASS,
  SIDEBAR_CHAT_ICON_NAME_OFFSET_PX,
  SIDEBAR_CHAT_TREE_INDENT_PX,
  SIDEBAR_CHAT_TREE_MAX_INDENT_DEPTH,
  sidebarChatRowInsetPx,
} from "@/shared/ui/sidebar-tokens";
import { SidebarChatMenuIcon } from "./SidebarChatMenuIcon";
import { DropdownMenu, DropdownMenuTrigger } from "@/shared/ui/dropdown-menu";
import { ContextMenu, ContextMenuTrigger } from "@/shared/ui/context-menu";
import { Input } from "@/shared/ui/input";
import { TreeGuide, type TreeGuideShape } from "@/shared/ui/tree-guide";
import {
  RESPONDING_SHIMMER_PROPS,
  Shimmer,
} from "@/shared/ui/ai-elements/shimmer";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";
import { SidebarUnreadDot } from "./SidebarUnreadDot";
import { SidebarChildWorkDot } from "./SidebarChildWorkDot";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import { workingChildCountForSession } from "@/features/conductor/brigadeActivity";
import { liveMonitorJobCount } from "@/features/conductor/monitorJobs";
import { useMonitorJobStore } from "@/features/conductor/monitorJobStore";
import { ConductorLeadingIcon } from "@/features/conductor/ui/ConductorLeadingIcon";
import { ActiveChatPulseDot } from "@/shared/ui/SessionActivityIndicator";
import { useWorkingIndicatorAnimationPreference } from "@/shared/preferences/workingIndicatorAnimationPreference";
import { useSidebarChatDrag } from "./SidebarChatDragContext";
import { SidebarHoverCard } from "./SidebarHoverCard";
import { SidebarChatPreview } from "./SidebarChatPreview";

const NO_TREE_GUIDES: readonly boolean[] = [];

/** Room on the row's right for its menu, or for its menu and a status dot. */
const MENU_RESERVE_CLASS = "pr-8";
const STATUS_RESERVE_CLASS = "pr-12";
const MENU_INSET_CLASS = "right-3";

const INACTIVE_CHAT_ROW_CLASS = cn(
  SIDEBAR_ROW_TEXT_DEFAULT_CLASS,
  SIDEBAR_ROW_HOVER_CLASS,
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
);
const ACTIVE_CHAT_ROW_CLASS = cn(
  SIDEBAR_ROW_ACTIVE_CLASS,
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
);
const SELECTED_CHAT_ROW_CLASS = cn(
  SIDEBAR_ROW_ACTIVE_CLASS,
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
);
/**
 * Merge contiguous selected rows into one visual block: a selected row drops
 * its top radius when the neighboring row is also selected.
 *
 * Structural contract: this works via CSS sibling selectors, so sections must
 * render chat rows as direct DOM siblings. A section that wraps each row in an
 * extra element (e.g. the pinned section's reorder wrapper) must mirror
 * `data-selected` onto that wrapper; the second selector group below matches
 * selected wrappers. Only the row's own button (`data-sidebar-chat-row-button`)
 * changes shape — auxiliary buttons like the menu trigger keep their radius.
 */
const SELECTED_CHAT_ROW_MERGE_CLASS = cn(
  // Rows as direct siblings (project/recents/flat sections).
  "[[data-selected]+&]:rounded-t-none [[data-selected]+&>[data-sidebar-chat-row-button]]:rounded-t-none",
  "has-[+[data-selected]]:rounded-b-none [&:has(+[data-selected])>[data-sidebar-chat-row-button]]:rounded-b-none",
  // Rows inside selected wrappers that are direct siblings (pinned section).
  "[[data-selected]+[data-selected]>&]:rounded-t-none [[data-selected]+[data-selected]>&>[data-sidebar-chat-row-button]]:rounded-t-none",
  "[[data-selected]:has(+[data-selected])>&]:rounded-b-none [[data-selected]:has(+[data-selected])>&>[data-sidebar-chat-row-button]]:rounded-b-none",
);

export interface SidebarChatRowProps {
  id: string;
  /**
   * Pre-promotion id for this chat, when it has one. Graph children spawned
   * before the session was promoted still point at this alias, so the
   * "agents working" indicator would miss them without it.
   */
  clientSessionId?: string;
  title: string;
  /** Current Git branch for this chat; only passed when the sidebar branch setting is enabled. */
  branchName?: string;
  /** Latest visible chat activity, shown in the hover preview. */
  activityAt?: string | null;
  isActive: boolean;
  isRunning?: boolean;
  hasUnread?: boolean;
  selected?: boolean;
  selectionEnabled?: boolean;
  selectionActionsDisabled?: boolean;
  selectedSessionIds?: Set<string>;
  className?: string;
  /** The list sits under a project row: its chats start at the project's name. */
  nested?: boolean;
  /**
   * How many chats deep this one sits under the chat that started it; 0 for
   * a chat in the list itself. A nested row hangs from its parent's guide
   * line, in the column under its parent's icon.
   */
  treeDepth?: number;
  /**
   * One entry per tree column before this row's own: whether an ancestor's
   * guide line passes through it, because that ancestor has siblings still
   * to come.
   */
  treeGuides?: readonly boolean[];
  /** Whether this chat is the last of its parent's: its line ends in an elbow. */
  treeIsLastChild?: boolean;
  /** Chats this one started and shows beneath it; 0 draws no disclosure. */
  childChatCount?: number;
  /** Whether those chats are shown; only read when there are any. */
  treeExpanded?: boolean;
  onToggleTree?: () => void;
  /** Leading pin-control policy for this list surface. */
  /** Rename guidance is omitted on surfaces where rows move under the pointer. */
  showRenameTooltip?: boolean;
  pointerDragEnabled?: boolean;
  /**
   * Whether the list shows the chat icon on plain chats. A conductor and a
   * chat with chats under it show their icon either way: it marks them and
   * heads the line their children hang from. The flat list shows the
   * project's icon instead.
   */
  showLeadingIcon?: boolean;
  flatProjectName?: string;
  flatProjectIcon?: string | null;
  flatProjectColor?: string | null;
  /** Project the chat currently lives in, or null when it sits in Recents. */
  currentProjectId?: string | null;
  /** Project chat group the chat currently lives in, when grouped. */
  currentProjectGroupId?: string | null;
  onEditProject?: (projectId: string) => void;
  onSelect?: (id: string) => void;
  onSelectionClear?: () => void;
  onSelectionChange?: (id: string, selected: boolean) => void;
  onRangeSelect?: (sessionId: string) => void;
  onRename?: (id: string, nextTitle: string) => void;
  onFork?: (id: string) => void;
  onArchive?: (id: string) => void;
  onArchiveSelected?: () => void;
  onMenuOpenChange?: (open: boolean) => void;
  onMarkRead?: (id: string) => void;
  onMarkUnread?: (id: string) => void;
  onMarkSelectedRead?: () => void;
  onMarkSelectedUnread?: () => void;
}

export function SidebarChatRow({
  id,
  clientSessionId,
  title,
  branchName,
  activityAt,
  isActive,
  isRunning = false,
  hasUnread = false,
  selected = false,
  selectionEnabled = false,
  selectionActionsDisabled = false,
  selectedSessionIds,
  className,
  nested = false,
  treeDepth = 0,
  treeGuides = NO_TREE_GUIDES,
  treeIsLastChild = true,
  childChatCount = 0,
  treeExpanded = true,
  onToggleTree,
  showRenameTooltip: _showRenameTooltip = true,
  pointerDragEnabled = true,
  showLeadingIcon = true,
  flatProjectName,
  flatProjectIcon,
  flatProjectColor,
  currentProjectId = null,
  currentProjectGroupId = null,
  onEditProject,
  onSelect,
  onSelectionClear,
  onSelectionChange,
  onRangeSelect,
  onRename,
  onFork,
  onArchive,
  onArchiveSelected,
  onMenuOpenChange,
  onMarkRead,
  onMarkUnread,
  onMarkSelectedRead,
  onMarkSelectedUnread,
}: SidebarChatRowProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const workingIndicatorAnimationPreference =
    useWorkingIndicatorAnimationPreference();
  const animateRunningState =
    isRunning && workingIndicatorAnimationPreference.enabled;
  const {
    draggingSession,
    beginSessionDrag,
    updateSessionDragTarget,
    endSessionDrag,
  } = useSidebarChatDrag();
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragPreviewPosition, setDragPreviewPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pointerDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);
  const pointerDragCleanupRef = useRef<(() => void) | null>(null);
  const suppressNextClickRef = useRef(false);
  const suppressNextClickResetRef = useRef<number | null>(null);
  const isConductor = useConductorGraphStore(
    (state) => state.nodesById[id]?.role === "conductor",
  );
  // Row-local and deliberately a plain number: zustand's default `Object.is`
  // comparison is enough, so this re-renders only when the tally changes.
  // A chat waiting on a job it started under flock-monitor is waiting on
  // external work just as one waiting on its agents is, and so is a chat
  // whose agent is: both read the same set of job owners.
  const liveJobOwnerIds = useMonitorJobStore((state) => state.liveOwnerIds);
  const workingChildCount = useConductorGraphStore((state) =>
    workingChildCountForSession(
      state.nodesById,
      id,
      [clientSessionId],
      liveJobOwnerIds,
    ),
  );
  const liveJobCount = useMonitorJobStore((state) =>
    liveMonitorJobCount(state.jobsById, [id, clientSessionId]),
  );
  const displayTitle = getDisplaySessionTitle(
    title,
    t("common:session.defaultTitle"),
  );
  const editableTitle = getEditableSessionTitle(
    title,
    t("common:session.defaultTitle"),
  );
  const [draftTitle, setDraftTitle] = useState(editableTitle);
  const hasFlatProjectColumn = flatProjectName != null;
  const trimmedBranchName = branchName?.trim() ?? "";
  const hasBranchName = trimmedBranchName.length > 0;
  const hasChildChats = childChatCount > 0;
  const isChildChat = treeDepth > 0;
  // Every chat in a list starts on one line (see `sidebarChatRowInsetPx`):
  // a conductor's or a tree root's icon, or a plain chat's name. The tree
  // is drawn in columns one icon wide from there. A child's elbow sits in
  // the column under its parent's icon and its name starts where its
  // parent's does; a child with children of its own takes the next column
  // for its icon, which heads the line its own children hang from. The
  // shell carries the tree inset as padding so the row's hover fill still
  // spans the panel; the glyphs and the icon are placed by column by hand.
  const slotInsetPx = sidebarChatRowInsetPx(nested);
  const treeColumns =
    treeGuides.length + (hasChildChats && isChildChat ? 1 : 0);
  const treeIndentPx =
    Math.min(treeColumns, SIDEBAR_CHAT_TREE_MAX_INDENT_DEPTH) *
    SIDEBAR_CHAT_TREE_INDENT_PX;
  const treeIndentStyle: CSSProperties | undefined =
    treeIndentPx > 0 ? { paddingLeft: treeIndentPx } : undefined;
  // The guide glyphs of this row, by column: the ancestors' lines that pass
  // it, its own line as a child, and the stub under its icon when its own
  // children are shown below.
  const treeGlyphs: Array<{ column: number; shape: TreeGuideShape }> = [];
  treeGuides.forEach((passes, column) => {
    if (passes) treeGlyphs.push({ column, shape: "pass" });
  });
  if (isChildChat) {
    treeGlyphs.push({
      column: treeGuides.length,
      shape: treeIsLastChild ? "last" : "pass",
    });
  }
  if (hasChildChats && treeExpanded) {
    treeGlyphs.push({ column: treeColumns, shape: "stub" });
  }
  const treeRail = treeGlyphs
    .filter(({ column }) => column < SIDEBAR_CHAT_TREE_MAX_INDENT_DEPTH)
    .map(({ column, shape }) => (
      <TreeGuide
        key={`${column}:${shape}`}
        shape={shape}
        style={{ left: slotInsetPx + column * SIDEBAR_CHAT_TREE_INDENT_PX }}
      />
    ));
  const selectionCount = selectedSessionIds?.size ?? 0;
  const shouldApplyToSelection = selected && selectionCount > 1;
  const showSelectionCheck =
    selectionEnabled && selected && onSelectionChange != null;
  const projectEditLabel = flatProjectName?.trim()
    ? t("actions.editProject", { name: flatProjectName })
    : t("actions.editProjectFallback");
  const rowButtonStateClass = selected
    ? SELECTED_CHAT_ROW_CLASS
    : isActive
      ? ACTIVE_CHAT_ROW_CLASS
      : INACTIVE_CHAT_ROW_CLASS;
  // The fold control sits after the name, the way the Claude app places it:
  // a chevron that always shows, down while the children are listed and
  // right while they are folded away. It lives inside the row button, so it
  // is not a button of its own: the row carries `aria-expanded`, and
  // ArrowRight / ArrowLeft on the focused row unfold and fold the subtree.
  const treeToggle = hasChildChats ? (
    <span
      role="presentation"
      data-sidebar-chat-tree-toggle
      data-sidebar-drag-ignore
      title={t(treeExpanded ? "tree.collapse" : "tree.expand", {
        name: displayTitle,
      })}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggleTree?.();
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      className="ml-1 inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
    >
      {treeExpanded ? (
        <IconChevronDown className="size-3" aria-hidden="true" />
      ) : (
        <IconChevronRight className="size-3" aria-hidden="true" />
      )}
    </span>
  ) : null;
  // Title block shared by the flat and grouped row variants: single-line
  // title, or a two-line title + git branch subtitle when a branch is shown.
  const titleText = animateRunningState ? (
    <Shimmer
      as="span"
      {...RESPONDING_SHIMMER_PROPS}
      baseColor="var(--color-sidebar-foreground)"
      highlightColor="color-mix(in srgb, var(--color-sidebar-foreground) 25%, var(--color-background))"
      className="!inline leading-[inherit] [--shimmer-ink:var(--color-sidebar-foreground)]"
    >
      {displayTitle}
    </Shimmer>
  ) : (
    displayTitle
  );
  const rowTitleContent = hasBranchName ? (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
      <span className="flex min-w-0 items-center">
        <span className="min-w-0 truncate leading-snug">{titleText}</span>
        {treeToggle}
      </span>
      <span className="flex min-w-0 items-center gap-1 truncate text-xs leading-snug text-muted-foreground/70">
        <IconGitBranch className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{trimmedBranchName}</span>
      </span>
    </span>
  ) : (
    <span className="flex min-w-0 flex-1 items-center text-left">
      <span className="min-w-0 truncate">{titleText}</span>
      {treeToggle}
    </span>
  );

  // What the leading slot shows. A nested chat without children shows
  // nothing of its own: its elbow, drawn in that column, is its mark in the
  // tree. In the flat list the slot is the chat's project. Elsewhere a
  // conductor shows its icon and a chat with chats under it the chat icon,
  // always, since each heads the line its children hang from; a plain chat
  // shows the chat icon only when the list shows icons.
  const leadingIdentity: ReactNode =
    isChildChat && !hasChildChats ? null : hasFlatProjectColumn ? (
      currentProjectId ? (
        <ProjectIcon
          icon={flatProjectIcon}
          color={flatProjectColor}
          projectId={currentProjectId}
          className="size-[18px]"
          imageClassName="size-[18px] rounded-[4px]"
        />
      ) : (
        <SidebarChatMenuIcon
          className="size-4"
          testId="sidebar-flat-chat-project-icon"
        />
      )
    ) : isConductor ? (
      <ConductorLeadingIcon />
    ) : hasChildChats || showLeadingIcon ? (
      <SidebarChatMenuIcon />
    ) : null;
  // A row with an icon, or with an elbow in its place, starts its name one
  // icon further in; a plain chat without one starts its name right there.
  const nameInsetPx =
    slotInsetPx +
    (leadingIdentity != null || isChildChat
      ? SIDEBAR_CHAT_ICON_NAME_OFFSET_PX
      : 0);

  const handleRowClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (onRangeSelect && isRangeSelectModifier(event)) {
      event.preventDefault();
      onRangeSelect(id);
      return;
    }
    if (isMultiSelectModifier(event)) {
      onSelectionChange?.(id, !selected);
      return;
    }
    if (selectionEnabled) {
      onSelectionClear?.();
    }
    onSelect?.(id);
  };

  // The tree-view convention: ArrowRight opens a folded parent, ArrowLeft
  // folds an open one. Only a row with children listens.
  const handleRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!hasChildChats) return;
    if (
      (event.key === "ArrowRight" && !treeExpanded) ||
      (event.key === "ArrowLeft" && treeExpanded)
    ) {
      event.preventDefault();
      onToggleTree?.();
    }
  };

  const handleRowDoubleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    startRename();
  };

  const rowButton = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-sidebar-chat-row-button
      onClick={handleRowClick}
      onDoubleClick={handleRowDoubleClick}
      onKeyDown={handleRowKeyDown}
      aria-label={displayTitle}
      aria-expanded={hasChildChats ? treeExpanded : undefined}
      style={{ paddingLeft: nameInsetPx }}
      className={cn(
        "min-w-0 flex-1 justify-start rounded-sm",
        isRunning || hasUnread ? STATUS_RESERVE_CLASS : MENU_RESERVE_CLASS,
        hasBranchName
          ? "h-auto py-1.5"
          : cn(SIDEBAR_ROW_HEIGHT_CLASS, SIDEBAR_ROW_VERTICAL_PADDING_CLASS),
        SIDEBAR_NAV_TEXT_CLASS,
        rowButtonStateClass,
      )}
      aria-pressed={selectionEnabled ? selected : undefined}
    >
      {rowTitleContent}
    </Button>
  );

  useEffect(() => {
    setDraftTitle(editableTitle);
  }, [editableTitle]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const closeMenus = () => {
    setMenuOpen(false);
    setContextMenuOpen(false);
    onMenuOpenChange?.(false);
  };

  const startRename = () => {
    setDraftTitle(editableTitle);
    closeMenus();
    setEditing(true);
  };

  const cancelRename = () => {
    setDraftTitle(editableTitle);
    setEditing(false);
  };

  const commitRename = () => {
    const nextTitle = draftTitle.trim();
    setEditing(false);
    if (
      !nextTitle ||
      isSessionTitleUnchanged(
        nextTitle,
        title,
        t("common:session.defaultTitle"),
      )
    ) {
      return;
    }
    onRename?.(id, nextTitle);
  };

  const handleExport = () => {
    void exportSessionAction({
      sessionId: id,
      title,
      displayTitle,
    });
  };

  const clearPointerDragListeners = () => {
    pointerDragCleanupRef.current?.();
    pointerDragCleanupRef.current = null;
  };

  const finishPointerDrag = () => {
    clearPointerDragListeners();
    pointerDragRef.current = null;
    setDragging(false);
    setDragPreviewPosition(null);
    endSessionDrag();
    if (suppressNextClickRef.current) {
      schedulePointerDragClickSuppressionReset(
        suppressNextClickRef,
        suppressNextClickResetRef,
      );
    }
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!isPrimaryPointerButton(event) || editing) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("[data-sidebar-drag-ignore]")
    ) {
      return;
    }

    clearPointerDragListeners();
    pointerDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || moveEvent.pointerId !== drag.pointerId) return;

      const isDragging =
        drag.dragging ||
        hasExceededPointerDragThreshold({
          startX: drag.startX,
          startY: drag.startY,
          clientX: moveEvent.clientX,
          clientY: moveEvent.clientY,
        });

      if (!isDragging) return;

      moveEvent.preventDefault();
      suppressNextClickRef.current = true;
      setDragPreviewPosition({ x: moveEvent.clientX, y: moveEvent.clientY });
      if (!drag.dragging) {
        pointerDragRef.current = { ...drag, dragging: true };
        closeMenus();
        setDragging(true);
        beginSessionDrag(id, currentProjectId, currentProjectGroupId);
      }
      updateSessionDragTarget(moveEvent.clientX, moveEvent.clientY);
    };

    const handlePointerUp = (upEvent: globalThis.PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || upEvent.pointerId !== drag.pointerId) return;

      if (drag.dragging) {
        upEvent.preventDefault();
        const target = updateSessionDragTarget(
          upEvent.clientX,
          upEvent.clientY,
        );
        target?.onDrop(id);
      }
      finishPointerDrag();
    };

    const handlePointerCancel = (cancelEvent: globalThis.PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || cancelEvent.pointerId !== drag.pointerId) return;
      finishPointerDrag();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    pointerDragCleanupRef.current = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  };

  useEffect(() => {
    return () => {
      pointerDragCleanupRef.current?.();
      clearPointerDragClickSuppression(
        suppressNextClickRef,
        suppressNextClickResetRef,
      );
    };
  }, []);

  const sessionActionsMenuProps = {
    sessionId: id,
    onClose: closeMenus,
    hasUnread,
    selectionCount: shouldApplyToSelection ? selectionCount : 0,
    selectionActionsDisabled,
    onMarkRead: shouldApplyToSelection
      ? onMarkSelectedRead
      : () => onMarkRead?.(id),
    onMarkUnread: shouldApplyToSelection
      ? onMarkSelectedUnread
      : () => onMarkUnread?.(id),
    onRename: startRename,
    onDuplicate: onFork ? () => onFork(id) : undefined,
    editProjectLabel: projectEditLabel,
    onEditProject:
      currentProjectId && onEditProject && hasFlatProjectColumn
        ? () => onEditProject(currentProjectId)
        : undefined,
    onExport: handleExport,
    onArchive: shouldApplyToSelection
      ? onArchiveSelected
      : () => onArchive?.(id),
  };

  if (editing) {
    return (
      <div
        className={cn("flex items-center group rounded-sm pr-0.5", className)}
        style={treeIndentStyle}
      >
        <Input
          ref={inputRef}
          type="text"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={commitRename}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              cancelRename();
            }
          }}
          className="flex-1 min-w-0 pr-3 text-sm font-normal"
          style={{ height: 32, paddingLeft: nameInsetPx }}
        />
      </div>
    );
  }

  return (
    <ContextMenu
      onOpenChange={(open) => {
        setContextMenuOpen(open);
        onMenuOpenChange?.(open);
      }}
    >
      <SidebarHoverCard
        label={displayTitle}
        disabled={
          menuOpen ||
          contextMenuOpen ||
          dragging ||
          draggingSession !== null ||
          selectionEnabled
        }
        content={
          <SidebarChatPreview
            title={displayTitle}
            activityAt={activityAt}
            projectId={currentProjectId}
            isRunning={isRunning}
          />
        }
      >
        <ContextMenuTrigger asChild>
          <div
            data-session-id={id}
            data-sidebar-chat-row
            data-sidebar-chat-draggable
            data-selected={selected ? "" : undefined}
            onPointerDown={pointerDragEnabled ? handlePointerDown : undefined}
            onClickCapture={(event) => {
              if (!suppressNextClickRef.current) return;
              clearPointerDragClickSuppression(
                suppressNextClickRef,
                suppressNextClickResetRef,
              );
              event.preventDefault();
              event.stopPropagation();
            }}
            className={cn(
              "relative flex items-center group/chat-row rounded-sm",
              SIDEBAR_ROW_SHELL_HOVER_CLASS,
              SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
              (isActive || menuOpen || contextMenuOpen) &&
                (!selectionEnabled || selected) &&
                SIDEBAR_ROW_SHELL_ACTIVE_CLASS,
              selected && SELECTED_CHAT_ROW_CLASS,
              selected && SELECTED_CHAT_ROW_MERGE_CLASS,
              draggingSession !== null && "pointer-events-none",
              dragging && "bg-[var(--sidebar-row-active)] opacity-40",
              className,
            )}
            data-sidebar-chat-tree-depth={isChildChat ? treeDepth : undefined}
            style={treeIndentStyle}
          >
            {dragging && dragPreviewPosition && typeof document !== "undefined"
              ? createPortal(
                  <div
                    aria-hidden="true"
                    data-sidebar-chat-drag-preview
                    className="pointer-events-none fixed z-50 flex max-w-72 items-center gap-2 rounded-sm border border-sidebar-border bg-card-glass px-3 py-2 text-sm text-sidebar-foreground shadow-lg [backdrop-filter:var(--backdrop-panel)] [-webkit-backdrop-filter:var(--backdrop-panel)]"
                    style={{
                      left: dragPreviewPosition.x + 12,
                      top: dragPreviewPosition.y + 12,
                    }}
                  >
                    <SidebarChatMenuIcon className="size-3.5 shrink-0" />
                    <span className="truncate">{displayTitle}</span>
                  </div>,
                  document.body,
                )
              : null}
            {treeRail}
            {leadingIdentity != null ? (
              <SidebarLeadingIcon
                className={cn(
                  "pointer-events-none absolute",
                  hasBranchName ? "top-2" : "top-1/2 -translate-y-1/2",
                  hasFlatProjectColumn && "text-muted-foreground/70",
                )}
                style={{ left: slotInsetPx + treeIndentPx }}
                activeLabel={t("status.chatActive")}
                unreadLabel={t("status.unreadMessages")}
              >
                {leadingIdentity}
              </SidebarLeadingIcon>
            ) : null}
            {rowButton}

            {isRunning ? (
              <span
                data-sidebar-chat-status
                role="status"
                aria-label={t("status.chatActive")}
                className={cn(
                  "pointer-events-none absolute flex size-5 items-center justify-center transition-opacity duration-75",
                  hasBranchName ? "top-1" : "top-1/2 -translate-y-1/2",
                  MENU_INSET_CLASS,
                  selectionEnabled || menuOpen || contextMenuOpen || dragging
                    ? "opacity-0"
                    : "opacity-100 group-hover/chat-row:opacity-0 group-focus-within/chat-row:opacity-0",
                )}
              >
                <ActiveChatPulseDot />
              </span>
            ) : workingChildCount > 0 || liveJobCount > 0 ? (
              // The chat itself is idle but its agents or its jobs are not:
              // the operator should expect a result later. Mirrors
              // `brigadeWaitIndicator`, which is likewise "only when the
              // session itself is idle", and so sits below the row's own
              // running state but above unread.
              <span
                data-sidebar-chat-children-status
                role="status"
                aria-label={[
                  workingChildCount > 0
                    ? t("status.childrenWorking", { count: workingChildCount })
                    : null,
                  liveJobCount > 0
                    ? t("status.jobsRunning", { count: liveJobCount })
                    : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
                className={cn(
                  "pointer-events-none absolute flex size-5 items-center justify-center transition-opacity duration-75",
                  hasBranchName ? "top-1" : "top-1/2 -translate-y-1/2",
                  MENU_INSET_CLASS,
                  selectionEnabled || menuOpen || contextMenuOpen || dragging
                    ? "opacity-0"
                    : "opacity-100 group-hover/chat-row:opacity-0 group-focus-within/chat-row:opacity-0",
                )}
              >
                <SidebarChildWorkDot />
              </span>
            ) : hasUnread ? (
              <span
                data-sidebar-chat-ready-status
                role="status"
                aria-label={t("status.unreadMessages")}
                className={cn(
                  "pointer-events-none absolute flex size-5 items-center justify-center transition-opacity duration-75",
                  hasBranchName ? "top-1" : "top-1/2 -translate-y-1/2",
                  MENU_INSET_CLASS,
                  selectionEnabled || menuOpen || contextMenuOpen || dragging
                    ? "opacity-0"
                    : "opacity-100 group-hover/chat-row:opacity-0 group-focus-within/chat-row:opacity-0",
                )}
              >
                <SidebarUnreadDot />
              </span>
            ) : null}

            {showSelectionCheck ? (
              <span
                className={cn(
                  "pointer-events-none absolute flex size-5 items-center justify-center rounded-sm transition-opacity duration-75",
                  MENU_INSET_CLASS,
                  dragging || menuOpen || contextMenuOpen
                    ? "opacity-0"
                    : "opacity-100 group-hover/chat-row:opacity-0 group-focus-within/chat-row:opacity-0",
                )}
                aria-hidden="true"
              >
                <IconCheck className="size-4 text-sidebar-foreground" />
              </span>
            ) : null}

            <DropdownMenu
              open={menuOpen}
              onOpenChange={(open) => {
                setMenuOpen(open);
                onMenuOpenChange?.(open);
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  flush
                  size="icon-xs"
                  aria-label={t("menu.optionsFor", { label: displayTitle })}
                  data-sidebar-drag-ignore
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    "absolute size-5",
                    MENU_INSET_CLASS,
                    dragging
                      ? "invisible pointer-events-none opacity-0"
                      : menuOpen
                        ? "visible opacity-100"
                        : "invisible opacity-0 group-hover/chat-row:visible group-hover/chat-row:opacity-100 group-focus-within/chat-row:visible group-focus-within/chat-row:opacity-100",
                  )}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <SessionActionsMenuContent {...sessionActionsMenuProps} />
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
      </SidebarHoverCard>
      <SessionActionsContextMenuContent {...sessionActionsMenuProps} />
    </ContextMenu>
  );
}
