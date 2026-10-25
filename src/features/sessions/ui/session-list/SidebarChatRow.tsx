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
  SIDEBAR_CHAT_ROW_DENSITY_CLASSES,
  SIDEBAR_CHAT_TREE_INDENT_PX,
  SIDEBAR_CHAT_TREE_MAX_INDENT_DEPTH,
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
  SIDEBAR_NAV_TEXT_CLASS,
  SIDEBAR_NESTED_ROW_PADDING_CLASS,
  SIDEBAR_ROW_ACTIVE_CLASS,
  SIDEBAR_ROW_HEIGHT_CLASS,
  SIDEBAR_ROW_HOVER_CLASS,
  SIDEBAR_ROW_SHELL_ACTIVE_CLASS,
  SIDEBAR_ROW_SHELL_HOVER_CLASS,
  SIDEBAR_ROW_TEXT_DEFAULT_CLASS,
  SIDEBAR_ROW_VERTICAL_PADDING_CLASS,
  type SidebarChatRowDensity,
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
import { ConductorLeadingIcon } from "@/features/conductor/ui/ConductorLeadingIcon";
import { ActiveChatPulseDot } from "@/shared/ui/SessionActivityIndicator";
import { useWorkingIndicatorAnimationPreference } from "@/shared/preferences/workingIndicatorAnimationPreference";
import { useSidebarChatDrag } from "./SidebarChatDragContext";
import { SidebarHoverCard } from "./SidebarHoverCard";
import { SidebarChatPreview } from "./SidebarChatPreview";

const NO_TREE_GUIDES: readonly boolean[] = [];

/**
 * Whether a surface keeps a leading slot in front of every row it shows: a
 * project's chats, rows with chat icons, the flat list's project column.
 *
 * It decides where a chat with children goes. Beside rows that have the
 * slot it moves one column right, so its icon clears their slot and heads
 * the line its children hang from. Where plain rows have no slot (Recents
 * without icons) its icon takes the slot itself and nothing moves — a
 * further shift would only push it deeper than its neighbours.
 */
export function hasReservedLeadingSlot(props: {
  nested?: boolean;
  showLeadingIcon?: boolean;
  flatProjectName?: string;
}): boolean {
  return Boolean(
    props.nested || props.showLeadingIcon || props.flatProjectName != null,
  );
}
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
  contentPaddingClassName?: string;
  nested?: boolean;
  /**
   * How many chats deep this one sits under the chat that started it; 0 for
   * a chat in the list itself. A nested row is indented one column per level
   * and hangs from its parent's guide line.
   */
  treeDepth?: number;
  /**
   * One entry per column before this row's own: whether an ancestor's guide
   * line passes through it. Length is the depth.
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
  density?: SidebarChatRowDensity;
  showLeadingIcon?: boolean;
  leadingIconTestId?: string;
  leadingIcon?: ReactNode;
  /** Semantic row geometry for surfaces with a compact 8px leading rail. */
  geometry?: "default" | "refreshed-primary" | "project-secondary";
  titleTone?: "default" | "muted";
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
  contentPaddingClassName,
  nested = false,
  treeDepth = 0,
  treeGuides = NO_TREE_GUIDES,
  treeIsLastChild = true,
  childChatCount = 0,
  treeExpanded = true,
  onToggleTree,
  showRenameTooltip: _showRenameTooltip = true,
  pointerDragEnabled = true,
  density = "default",
  showLeadingIcon = true,
  leadingIconTestId,
  leadingIcon,
  geometry = "default",
  titleTone = "default",
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
  const workingChildCount = useConductorGraphStore((state) =>
    workingChildCountForSession(state.nodesById, id, [clientSessionId]),
  );
  const resolvedLeadingIcon = isConductor
    ? (leadingIcon ?? <ConductorLeadingIcon />)
    : leadingIcon;
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
  const densityClasses = SIDEBAR_CHAT_ROW_DENSITY_CLASSES[density];
  // The tree is drawn in columns one leading slot wide. A row gets one
  // column per ancestor level, and a chat with children one more, so its
  // icon stands above the line its children hang from and its title starts
  // where theirs do. The shell carries the inset as padding so the row's
  // hover fill still spans the panel; the glyphs and the leading slot are
  // placed by column by hand.
  const treeUnitPx = hasFlatProjectColumn
    ? densityClasses.flatProjectIconColumnPx
    : SIDEBAR_CHAT_TREE_INDENT_PX;
  const leadingSlotReserved = hasReservedLeadingSlot({
    nested,
    showLeadingIcon,
    flatProjectName,
  });
  const treeColumns =
    treeGuides.length +
    (hasChildChats && (isChildChat || leadingSlotReserved) ? 1 : 0);
  const treeIndentPx =
    Math.min(treeColumns, SIDEBAR_CHAT_TREE_MAX_INDENT_DEPTH) * treeUnitPx;
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
  // Running and ready/unread states share the trailing menu slot.
  const needsLeadingSlot =
    nested ||
    showLeadingIcon ||
    isConductor ||
    hasFlatProjectColumn ||
    hasChildChats ||
    isChildChat;
  const showAbsoluteLeadingSlot = !hasFlatProjectColumn && needsLeadingSlot;
  const rowPaddingClass =
    geometry === "project-secondary"
      ? nested
        ? "pl-9"
        : needsLeadingSlot
          ? "pl-8"
          : "pl-[10px]"
      : (contentPaddingClassName ??
        (geometry === "refreshed-primary"
          ? needsLeadingSlot
            ? "pl-8"
            : "pl-2"
          : needsLeadingSlot
            ? SIDEBAR_NESTED_ROW_PADDING_CLASS
            : densityClasses.contentPadding));
  // The chat icon and quick-pin action deliberately share the left gutter:
  // pinning replaces the icon rather than creating a second position.
  const leadingControlInsetClass = geometry === "default" ? "left-3" : "left-2";
  const leadingControlInsetPx = hasFlatProjectColumn
    ? 12
    : geometry === "default"
      ? 12
      : 8;
  const leadingSlotStyle: CSSProperties | undefined =
    treeIndentPx > 0
      ? { left: leadingControlInsetPx + treeIndentPx }
      : undefined;
  const treeRail = treeGlyphs
    .filter(({ column }) => column < SIDEBAR_CHAT_TREE_MAX_INDENT_DEPTH)
    .map(({ column, shape }) => (
      <TreeGuide
        key={`${column}:${shape}`}
        shape={shape}
        style={{ left: leadingControlInsetPx + column * treeUnitPx }}
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
  const absoluteLeadingSlotClass = cn(
    "absolute flex size-4 shrink-0 items-center justify-center",
    hasBranchName ? "top-2" : "top-1/2 -translate-y-1/2",
    leadingControlInsetClass,
  );
  // What the leading slot shows at rest. A nested chat without children
  // shows nothing of its own there: the guide line it hangs from is drawn
  // through that column by the rail, and is its identity in the tree.
  // What the leading slot shows. A chat with chats under it always shows
  // its icon: it heads the line its children hang from. A nested chat
  // without children shows nothing of its own there; the guide line the
  // rail draws through that column is its identity in the tree.
  const leadingIdentity: ReactNode = hasChildChats
    ? (resolvedLeadingIcon ?? <SidebarChatMenuIcon />)
    : isChildChat
      ? null
      : showLeadingIcon || isConductor
        ? (resolvedLeadingIcon ?? <SidebarChatMenuIcon />)
        : null;
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
        <span
          className={cn(
            "min-w-0 truncate leading-snug",
            titleTone === "muted" && "text-muted-foreground",
          )}
        >
          {titleText}
        </span>
        {treeToggle}
      </span>
      <span className="flex min-w-0 items-center gap-1 truncate text-xs leading-snug text-muted-foreground/70">
        <IconGitBranch className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{trimmedBranchName}</span>
      </span>
    </span>
  ) : (
    <span className="flex min-w-0 flex-1 items-center text-left">
      <span
        className={cn(
          "min-w-0 truncate",
          titleTone === "muted" && "text-muted-foreground",
        )}
      >
        {titleText}
      </span>
      {treeToggle}
    </span>
  );

  const flatProjectIconColumnClass = cn(
    "flex shrink-0 items-center justify-center",
    densityClasses.flatProjectIconColumn,
  );
  const flatProjectIconSlotClass = cn(
    flatProjectIconColumnClass,
    densityClasses.flatProjectIconInset,
    hasBranchName && "mt-1.5 self-start",
  );
  const flatProjectGlyph = currentProjectId ? (
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
  );
  // In the flat list the project glyph is the row's identity — except for a
  // nested chat without children, which belongs to its parent's project by
  // construction and hangs from the guide line instead.
  const flatLeadingIdentity: ReactNode =
    isChildChat && !hasChildChats ? null : (
      <span aria-hidden="true" data-sidebar-flat-project-icon>
        {flatProjectGlyph}
      </span>
    );

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
      className={cn(
        "min-w-0 flex-1 justify-start rounded-sm",
        hasFlatProjectColumn ? "pl-0 gap-0" : rowPaddingClass,
        isRunning || hasUnread
          ? densityClasses.statusReserve
          : densityClasses.menuReserve,
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
          className={cn(
            "flex-1 min-w-0 pr-3 text-sm font-normal",
            rowPaddingClass,
          )}
          style={{ height: 32 }}
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
              hasFlatProjectColumn && densityClasses.flatProjectGap,
              className,
            )}
            data-sidebar-chat-density={density}
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
            {showAbsoluteLeadingSlot ? (
              <SidebarLeadingIcon
                className={absoluteLeadingSlotClass}
                style={leadingSlotStyle}
                activeLabel={t("status.chatActive")}
                unreadLabel={t("status.unreadMessages")}
                testId={leadingIconTestId}
              >
                {leadingIdentity}
              </SidebarLeadingIcon>
            ) : null}
            {hasFlatProjectColumn ? (
              <>
                <SidebarLeadingIcon
                  activeLabel={t("status.chatActive")}
                  unreadLabel={t("status.unreadMessages")}
                  className={cn(
                    "rounded-sm text-muted-foreground/70",
                    flatProjectIconSlotClass,
                  )}
                >
                  {flatLeadingIdentity}
                </SidebarLeadingIcon>
                {rowButton}
              </>
            ) : (
              rowButton
            )}

            {isRunning ? (
              <span
                data-sidebar-chat-status
                role="status"
                aria-label={t("status.chatActive")}
                className={cn(
                  "pointer-events-none absolute flex size-5 items-center justify-center transition-opacity duration-75",
                  hasBranchName ? "top-1" : "top-1/2 -translate-y-1/2",
                  densityClasses.menuInset,
                  selectionEnabled || menuOpen || contextMenuOpen || dragging
                    ? "opacity-0"
                    : "opacity-100 group-hover/chat-row:opacity-0 group-focus-within/chat-row:opacity-0",
                )}
              >
                <ActiveChatPulseDot />
              </span>
            ) : workingChildCount > 0 ? (
              // The chat itself is idle but its agents are not: the operator
              // should expect a result later. Mirrors `brigadeWaitIndicator`,
              // which is likewise "only when the session itself is idle", and so
              // sits below the row's own running state but above unread.
              <span
                data-sidebar-chat-children-status
                role="status"
                aria-label={t("status.childrenWorking", {
                  count: workingChildCount,
                })}
                className={cn(
                  "pointer-events-none absolute flex size-5 items-center justify-center transition-opacity duration-75",
                  hasBranchName ? "top-1" : "top-1/2 -translate-y-1/2",
                  densityClasses.menuInset,
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
                  densityClasses.menuInset,
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
                  densityClasses.menuInset,
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
                    densityClasses.menuInset,
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
