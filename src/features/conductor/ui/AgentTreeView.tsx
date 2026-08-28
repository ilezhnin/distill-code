import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconChevronDown,
  IconChevronRight,
  IconPlayerStop,
} from "@tabler/icons-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

import type { AgentTreeNode } from "../agentTree";
import { isWorkingStatus } from "../brigadeActivity";
import { BrigadeStatusGlyph } from "./BrigadeChip";

/**
 * The agent forest, drawn.
 *
 * One renderer for every "who is working for me" surface: the project
 * sidebar's Agents section, and the tree a chat offers over its own brigade.
 * They must not diverge, because the operator learns this shape once — an
 * indented list where every row is the same clickable thing, all the way down
 * to the last subagent.
 *
 * Rows start expanded. This component exists because agents were invisible;
 * defaulting to collapsed would put them one click away from invisible again.
 */

/**
 * A deterministic stand-in avatar: the agent's initial in a neutral disc.
 *
 * Personas load asynchronously and most spawned agents carry none at all, so
 * a real avatar would leave most rows with a hole in them. Deliberately not
 * colored per role, for the reason the digest card gives: every color token
 * this app has carries run-status meaning (`BrigadeStatusGlyph`), and a
 * decorative role color drawn from the same palette would read as a status.
 * Identity is the letter, the name beside it, and the indent.
 */
function AgentAvatar({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-semibold text-foreground",
        className,
      )}
    >
      {initial}
    </span>
  );
}

export interface AgentTreeViewProps {
  forest: readonly AgentTreeNode[];
  /** Highlighted row, when one of these agents is the open conversation. */
  activeSessionId?: string | null;
  onOpen: (sessionId: string) => void;
  /** Omitted → no stop control, whatever the status. */
  onStop?: (sessionId: string) => void;
  /** Left inset of a depth-0 row, in px. Depth adds 12px per level. */
  baseIndentPx?: number;
  className?: string;
}

export function AgentTreeView({
  forest,
  activeSessionId,
  onOpen,
  onStop,
  baseIndentPx = 0,
  className,
}: AgentTreeViewProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const toggle = useCallback((sessionId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  if (forest.length === 0) return null;

  return (
    <div className={cn("flex flex-col", className)} data-testid="agent-tree">
      {forest.map((tree) => (
        <AgentTreeBranch
          key={tree.node.sessionId}
          tree={tree}
          collapsed={collapsed}
          onToggle={toggle}
          activeSessionId={activeSessionId}
          onOpen={onOpen}
          onStop={onStop}
          baseIndentPx={baseIndentPx}
        />
      ))}
    </div>
  );
}

function AgentTreeBranch({
  tree,
  collapsed,
  onToggle,
  activeSessionId,
  onOpen,
  onStop,
  baseIndentPx,
}: {
  tree: AgentTreeNode;
  collapsed: ReadonlySet<string>;
  onToggle: (sessionId: string) => void;
  activeSessionId?: string | null;
  onOpen: (sessionId: string) => void;
  onStop?: (sessionId: string) => void;
  baseIndentPx: number;
}) {
  const { t } = useTranslation("chat");
  const { node, children, workingInSubtree } = tree;
  const hasChildren = children.length > 0;
  const isCollapsed = collapsed.has(node.sessionId);
  const isActive = activeSessionId === node.sessionId;
  const statusLabel = t(`conductor.status.${node.status}`);
  // A collapsed parent must still account for the agents it is hiding —
  // otherwise collapsing a row is indistinguishable from those agents ending.
  const hiddenWorking = isCollapsed
    ? workingInSubtree - (isWorkingStatus(node.status) ? 1 : 0)
    : 0;

  return (
    <>
      <div
        data-testid="agent-tree-row"
        data-session-id={node.sessionId}
        data-depth={tree.depth}
        data-status={node.status}
        className={cn(
          "group/agent-row flex min-w-0 items-center gap-0.5 rounded-sm pr-1",
          "hover:bg-[var(--sidebar-row-hover)] focus-within:bg-[var(--sidebar-row-hover)]",
          isActive && "bg-[var(--sidebar-row-active)]",
        )}
        style={{ paddingLeft: baseIndentPx + tree.depth * 12 }}
      >
        {hasChildren ? (
          <button
            type="button"
            data-testid="agent-tree-toggle"
            aria-expanded={!isCollapsed}
            aria-label={t("conductor.agents.toggle", {
              name: node.displayName,
            })}
            onClick={() => onToggle(node.sessionId)}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
          >
            {isCollapsed ? (
              <IconChevronRight className="size-3" aria-hidden="true" />
            ) : (
              <IconChevronDown className="size-3" aria-hidden="true" />
            )}
          </button>
        ) : (
          <span className="size-4 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          data-testid="agent-tree-open"
          title={
            node.task
              ? `${node.displayName} — ${statusLabel}\n${node.task}`
              : t("conductor.openChild", {
                  name: node.displayName,
                  status: statusLabel,
                })
          }
          onClick={() => onOpen(node.sessionId)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-1 pl-0.5 pr-1 text-left text-xs"
        >
          <AgentAvatar name={node.displayName} />
          <span className="min-w-0 flex-1 truncate">{node.displayName}</span>
          {hiddenWorking > 0 ? (
            <span
              data-testid="agent-tree-hidden-working"
              className="shrink-0 rounded-full bg-info/15 px-1.5 text-[10px] text-info"
            >
              {t("conductor.agents.hiddenWorking", { count: hiddenWorking })}
            </span>
          ) : null}
          <BrigadeStatusGlyph status={node.status} />
        </button>
        {onStop && isWorkingStatus(node.status) ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xxs"
            destructive
            data-testid="agent-tree-stop"
            aria-label={t("conductor.stopChild", { name: node.displayName })}
            title={t("conductor.stopChild", { name: node.displayName })}
            className="shrink-0 opacity-0 group-hover/agent-row:opacity-100 group-focus-within/agent-row:opacity-100"
            onClick={() => onStop(node.sessionId)}
          >
            <IconPlayerStop aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {hasChildren && !isCollapsed
        ? children.map((child) => (
            <AgentTreeBranch
              key={child.node.sessionId}
              tree={child}
              collapsed={collapsed}
              onToggle={onToggle}
              activeSessionId={activeSessionId}
              onOpen={onOpen}
              onStop={onStop}
              baseIndentPx={baseIndentPx}
            />
          ))
        : null}
    </>
  );
}
