import { IconPlayerPause, IconPlayerStop } from "@tabler/icons-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useChatStore } from "@/features/chat/stores/chatStore";
import { cn } from "@/shared/lib/cn";
import { ActiveChatPulseDot } from "@/shared/ui/SessionActivityIndicator";

import type { RunStatus, SessionNode, StructuredReport } from "../types";

const STATUS_DOT_CLASS: Record<RunStatus, string> = {
  starting: "bg-info",
  running: "bg-info",
  waiting: "bg-warning",
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground",
  stopped: "bg-muted-foreground",
};

function isWorkingStatus(status: RunStatus): boolean {
  return status === "starting" || status === "running" || status === "waiting";
}

function formatTokenCount(value: number): string {
  if (value >= 1000) {
    const thousands = value / 1000;
    return `${thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(Math.round(value));
}

function AgentStatusGlyph({ status }: { status: RunStatus }) {
  if (status === "running" || status === "starting") {
    return <ActiveChatPulseDot className="shrink-0" />;
  }
  if (status === "waiting") {
    return (
      <IconPlayerPause
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", STATUS_DOT_CLASS[status])}
    />
  );
}

export function ConductorAgentFooter({
  nodes,
  reportsByRunId,
  onOpen,
  onStop,
  className,
}: {
  nodes: readonly SessionNode[];
  reportsByRunId: Record<string, StructuredReport>;
  onOpen?: (sessionId: string) => void;
  onStop?: (sessionId: string) => void;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const sessionStateById = useChatStore((state) => state.sessionStateById);
  const tokenTotals = useMemo(() => {
    let accumulatedTotal = 0;
    let accumulatedCost = 0;
    let hasCost = false;
    for (const node of nodes) {
      const tokenState = sessionStateById[node.sessionId]?.tokenState;
      if (!tokenState) continue;
      accumulatedTotal += tokenState.accumulatedTotal;
      if (typeof tokenState.accumulatedCost === "number") {
        accumulatedCost += tokenState.accumulatedCost;
        hasCost = true;
      }
    }
    return { accumulatedTotal, accumulatedCost, hasCost };
  }, [nodes, sessionStateById]);

  const stats = useMemo(() => {
    const working = nodes.filter((node) => isWorkingStatus(node.status)).length;
    const done = nodes.filter((node) => node.status === "completed").length;
    const parts: string[] = [];
    if (working > 0) {
      parts.push(t("conductor.statsWorking", { count: working }));
    }
    if (done > 0) {
      parts.push(t("conductor.statsDone", { count: done }));
    }
    if (tokenTotals.accumulatedTotal > 0) {
      parts.push(
        t("conductor.statsTokens", {
          tokens: formatTokenCount(tokenTotals.accumulatedTotal),
        }),
      );
    }
    if (tokenTotals.hasCost && tokenTotals.accumulatedCost > 0) {
      parts.push(
        t("conductor.statsCost", {
          cost: tokenTotals.accumulatedCost.toFixed(2),
        }),
      );
    }
    return parts.join(" · ");
  }, [nodes, t, tokenTotals]);

  if (nodes.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="conductor-agent-footer"
      className={cn(
        "flex w-full min-w-0 flex-col items-start gap-1 pt-1",
        className,
      )}
    >
      {stats ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="conductor-stats"
        >
          {stats}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {nodes.map((node) => {
          const report = node.runId ? reportsByRunId[node.runId] : undefined;
          const statusLabel = t(`conductor.status.${node.status}`);
          const working = isWorkingStatus(node.status);
          return (
            <span
              key={node.sessionId}
              className="inline-flex items-center gap-1"
            >
              <button
                type="button"
                data-testid="conductor-agent-chip"
                aria-label={t("conductor.openChild", {
                  name: node.displayName,
                  status: statusLabel,
                })}
                title={report?.summary || node.task || statusLabel}
                onClick={() => onOpen?.(node.sessionId)}
                className="inline-flex items-center gap-1.5 rounded-full text-xs text-muted-foreground hover:text-foreground"
              >
                <AgentStatusGlyph status={node.status} />
                <span className="font-medium text-foreground">
                  {node.displayName}
                </span>
              </button>
              {working && onStop ? (
                <button
                  type="button"
                  data-testid="conductor-agent-stop"
                  aria-label={t("conductor.stopChild", {
                    name: node.displayName,
                  })}
                  onClick={() => onStop(node.sessionId)}
                  className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <IconPlayerStop className="size-3" />
                </button>
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}
