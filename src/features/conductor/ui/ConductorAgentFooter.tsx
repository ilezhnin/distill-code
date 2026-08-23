import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useChatStore } from "@/features/chat/stores/chatStore";
import { cn } from "@/shared/lib/cn";

import { summarizeBrigadeActivity } from "../brigadeActivity";
import type { SessionNode, StructuredReport } from "../types";
import { BrigadeChip, type BrigadeChipViewModel } from "./BrigadeChip";

function formatTokenCount(value: number): string {
  if (value >= 1000) {
    const thousands = value / 1000;
    return `${thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(Math.round(value));
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
    const { working, done } = summarizeBrigadeActivity(nodes);
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

  // SessionNode → the session-free chip view model; stage 2b feeds the same
  // component ephemeral harness subagents that have no session at all.
  const chips = useMemo<BrigadeChipViewModel[]>(
    () =>
      nodes.map((node) => {
        const report = node.runId ? reportsByRunId[node.runId] : undefined;
        return {
          id: node.sessionId,
          name: node.displayName,
          status: node.status,
          title: report?.summary || node.task || undefined,
          // The chip hands the session id back; `onOpenChild` applies its own
          // default intent (navigate).
          onOpen,
          onStop,
        };
      }),
    [nodes, onOpen, onStop, reportsByRunId],
  );

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
        {chips.map((chip) => (
          <BrigadeChip key={chip.id} {...chip} />
        ))}
      </div>
    </div>
  );
}
