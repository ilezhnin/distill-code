import {
  setChatTreeCollapsed,
  useCollapsedChatTrees,
} from "@/features/sidebar/lib/sidebarChatTreeCollapse";

import { SidebarChatRow, type SidebarChatRowProps } from "./SidebarChatRow";
import type { SidebarSessionItem } from "./SidebarProjectSection";

/**
 * A chat row and, nested beneath it, the rows of the agents it started — at
 * every depth, finished or not.
 *
 * This is how the sidebar keeps the product's transparency rule: an agent
 * working on the operator's behalf is visible from the place they already
 * look, under the chat that is waiting on it, and every row opens that
 * agent's own chat. A finished agent stays where it was, because the chat it
 * reported to is where the operator will go looking for it.
 *
 * Rows are rendered as siblings rather than wrapped per subtree so the list's
 * DOM order is the visual order: range selection and the merged selection
 * styling both read it that way. The tree's guide lines are the row's own
 * business; the branch only tells each row which ancestors' lines pass it
 * and whether it is the last of its siblings.
 */

type PerSessionRowProp =
  | "id"
  | "clientSessionId"
  | "title"
  | "branchName"
  | "activityAt"
  | "isActive"
  | "isRunning"
  | "hasUnread"
  | "selected"
  | "treeDepth"
  | "treeGuides"
  | "treeIsLastChild"
  | "childChatCount"
  | "treeExpanded"
  | "onToggleTree";

/** The row props a list surface sets once for every chat it shows. */
export type SidebarChatBranchRowProps = Omit<
  SidebarChatRowProps,
  PerSessionRowProp
>;

export interface SidebarChatBranchProps extends SidebarChatBranchRowProps {
  session: SidebarSessionItem;
  activeSessionId?: string | null;
  /** 0 for a chat in the list itself; the branch sets it for its children. */
  depth?: number;
  /** Set by the branch for its children; a chat in the list has no siblings here. */
  isLastChild?: boolean;
  /** Set by the branch for its children: which ancestors' lines pass this row. */
  ancestorGuides?: readonly boolean[];
}

const NO_GUIDES: readonly boolean[] = [];

export function SidebarChatBranch({
  session,
  activeSessionId,
  depth = 0,
  isLastChild = true,
  ancestorGuides = NO_GUIDES,
  ...rowProps
}: SidebarChatBranchProps) {
  const collapsedTrees = useCollapsedChatTrees();
  const children = session.children ?? [];
  const expanded = children.length > 0 && !collapsedTrees.has(session.id);
  // A child of this row sees every line this row sees, plus this row's own
  // line when this row is itself a child with siblings still to come. A chat
  // in the list has no line of its own: its children's line starts under it.
  const childGuides =
    depth === 0 ? NO_GUIDES : [...ancestorGuides, !isLastChild];

  return (
    <>
      <SidebarChatRow
        {...rowProps}
        id={session.id}
        clientSessionId={session.clientSessionId}
        title={session.title}
        branchName={session.branchName}
        activityAt={session.activityAt}
        isActive={activeSessionId === session.id}
        isRunning={session.isRunning ?? false}
        hasUnread={session.hasUnread ?? false}
        selected={rowProps.selectedSessionIds?.has(session.id) ?? false}
        // An agent's chat belongs with the chat that started it; dragging it
        // into another project would only detach the row from its tree.
        pointerDragEnabled={
          depth === 0 && (rowProps.pointerDragEnabled ?? true)
        }
        treeDepth={depth}
        treeGuides={ancestorGuides}
        treeIsLastChild={isLastChild}
        childChatCount={children.length}
        treeExpanded={expanded}
        onToggleTree={() => setChatTreeCollapsed(session.id, expanded)}
      />
      {expanded
        ? children.map((child, index) => (
            <SidebarChatBranch
              key={child.id}
              {...rowProps}
              session={child}
              activeSessionId={activeSessionId}
              depth={depth + 1}
              isLastChild={index === children.length - 1}
              ancestorGuides={childGuides}
            />
          ))
        : null}
    </>
  );
}
