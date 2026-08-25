import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useChatStore } from "@/features/chat/stores/chatStore";
import { cn } from "@/shared/lib/cn";

import type { ConductorOpenChildIntent } from "../ConductorTranscriptContext";
import { summarizeBrigadeActivity } from "../brigadeActivity";
import { pendingStepName, waveFooterRow } from "../waveFooterChips";
import { waveStepAccessKey } from "../distillConductorTranscript";
import type { WaveStep } from "../distillWave";
import type { SessionNode, StructuredReport } from "../types";
import { BrigadeChip, type BrigadeChipViewModel } from "./BrigadeChip";

function formatTokenCount(value: number): string {
  if (value >= 1000) {
    const thousands = value / 1000;
    return `${thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(Math.round(value));
}

/**
 * Wave children in plan order.
 *
 * The graph hands them back in registration order, which is spawn-completion
 * order — so a wave whose second step started faster than its first showed its
 * chips out of order. Failure attribution starts with "which step", so the row
 * has to read like the plan above it. Nodes without a `stepIndex` (legacy
 * orchestrator children) keep their relative order at the end.
 */
function inPlanOrder(nodes: readonly SessionNode[]): readonly SessionNode[] {
  if (nodes.length < 2) return nodes;
  if (!nodes.some((node) => typeof node.stepIndex === "number")) return nodes;
  const rank = (node: SessionNode) =>
    typeof node.stepIndex === "number"
      ? node.stepIndex
      : Number.MAX_SAFE_INTEGER;
  return [...nodes].sort((left, right) => rank(left) - rank(right));
}

export function ConductorAgentFooter({
  nodes,
  reportsByRunId,
  planSteps,
  onOpen,
  onStop,
  className,
}: {
  nodes: readonly SessionNode[];
  reportsByRunId: Record<string, StructuredReport>;
  /**
   * Steps of the wave plan this message carried, if it carried one. Read for
   * each chip's access mode; absent for a legacy orchestrator row, and then the
   * chips simply show no access.
   */
  planSteps?: readonly WaveStep[];
  onOpen?: (sessionId: string, intent?: ConductorOpenChildIntent) => void;
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

  // Clicking a chip for a real session opens that child's transcript beside
  // the conversation instead of replacing it; full navigation is the explicit
  // "open fully" control in the tab header. Ephemeral harness chips never come
  // through here — they carry their own reveal handler.
  const openInTab = useMemo(
    () =>
      onOpen
        ? (sessionId: string) => onOpen(sessionId, "openInTab")
        : undefined,
    [onOpen],
  );

  // The row is built from the plan when this message carried one, so every
  // step the operator agreed to holds a place from the moment the plan lands
  // — a four-step wave whose first step is slow to start is four chips, not
  // one that the others appear beside as they spawn.
  const chips = useMemo<BrigadeChipViewModel[]>(() => {
    const chipForNode = (node: SessionNode): BrigadeChipViewModel => {
      const report = node.runId ? reportsByRunId[node.runId] : undefined;
      const step =
        typeof node.stepIndex === "number"
          ? planSteps?.[node.stepIndex]
          : undefined;
      return {
        id: node.sessionId,
        name: node.displayName,
        status: node.status,
        title: report?.summary || node.task || undefined,
        stepIndex: node.stepIndex,
        accessLabel: step ? t(waveStepAccessKey(step)) : undefined,
        onOpen: openInTab,
        onStop,
      };
    };

    const { slots, unplanned } = waveFooterRow(planSteps ?? [], nodes);
    return [
      ...slots.map((slot) =>
        slot.node
          ? chipForNode(slot.node)
          : {
              // Keyed on the step, since there is no session to key on yet.
              id: `step-${slot.stepIndex}`,
              name: pendingStepName(slot.step),
              // Unused while `pending` is set; the chip reads its own label.
              status: "starting" as const,
              title: slot.step.subtask,
              stepIndex: slot.stepIndex,
              accessLabel: t(waveStepAccessKey(slot.step)),
              pending: true,
            },
      ),
      ...inPlanOrder(unplanned).map(chipForNode),
    ];
  }, [nodes, onStop, openInTab, planSteps, reportsByRunId, t]);

  if (chips.length === 0) {
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
