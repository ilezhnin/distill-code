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

/**
 * What one step has spent, or nothing at all.
 *
 * Cost wins when the provider prices its tokens, because money is the number
 * the operator is actually deciding about; tokens are the fallback for a
 * provider that reports none, and a step that has reported neither shows
 * nothing rather than a zero it has not earned.
 */
function spendLabelFor(
  tokenState:
    | { accumulatedTotal: number; accumulatedCost?: number | null }
    | undefined,
): string | undefined {
  if (!tokenState) return undefined;
  if (
    typeof tokenState.accumulatedCost === "number" &&
    tokenState.accumulatedCost > 0
  ) {
    return `$${tokenState.accumulatedCost.toFixed(2)}`;
  }
  if (tokenState.accumulatedTotal > 0) {
    return formatTokenCount(tokenState.accumulatedTotal);
  }
  return undefined;
}

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
  hostSessionId,
  nodes,
  reportsByRunId,
  planSteps,
  onOpen,
  onStop,
  className,
}: {
  /**
   * The conversation this row hangs under — the conductor itself.
   *
   * The totals used to count only the executors, which stopped being true the
   * moment the conductor became a real model call of its own: it reads every
   * report, judges every digest and plans every revision, and on a long root
   * request it is often the largest single line in the bill. A footer that
   * silently omitted it hid the most likely source of a runaway spend from
   * the one number the operator watches.
   */
  hostSessionId?: string;
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
    const add = (sessionId: string) => {
      const tokenState = sessionStateById[sessionId]?.tokenState;
      if (!tokenState) return;
      accumulatedTotal += tokenState.accumulatedTotal;
      if (typeof tokenState.accumulatedCost === "number") {
        accumulatedCost += tokenState.accumulatedCost;
        hasCost = true;
      }
    };
    if (hostSessionId) add(hostSessionId);
    for (const node of nodes) add(node.sessionId);
    return { accumulatedTotal, accumulatedCost, hasCost };
  }, [hostSessionId, nodes, sessionStateById]);

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
  const groups = useMemo<ChipGroup[]>(() => {
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
        spendLabel: spendLabelFor(sessionStateById[node.sessionId]?.tokenState),
        stepIndex: node.stepIndex,
        accessLabel: step ? t(waveStepAccessKey(step)) : undefined,
        // D5: a step the plan pinned to a model wears it on the chip. The raw
        // plan string, deliberately — the chip states the instruction; what it
        // resolved to is on the child tab and in the spawn notices.
        modelLabel: step?.model,
        onOpen: openInTab,
        onStop,
      };
    };

    const rowFor = (
      forNodes: readonly SessionNode[],
      steps: readonly WaveStep[] | undefined,
    ): BrigadeChipViewModel[] => {
      const { slots, unplanned } = waveFooterRow(steps ?? [], forNodes);
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
                modelLabel: slot.step.model,
                pending: true,
              },
        ),
        ...inPlanOrder(unplanned).map(chipForNode),
      ];
    };

    // One message can host more than one wave: a revision spawns against the
    // same plan message its predecessor did, and until now its executors
    // simply joined the earlier row, so eight chips claimed to be one brigade
    // of eight. Grouped by wave, the second row reads as what it is — the
    // revision — and the plan's own slots stay with the wave the plan
    // described.
    const waves = groupNodesByWave(nodes);
    if (waves.length <= 1) {
      return [{ waveId: waves[0]?.waveId, chips: rowFor(nodes, planSteps) }];
    }
    return waves.map((group, index) => ({
      waveId: group.waveId,
      revisionIndex: index,
      chips: rowFor(group.nodes, index === 0 ? planSteps : undefined),
    }));
  }, [
    nodes,
    onStop,
    openInTab,
    planSteps,
    reportsByRunId,
    sessionStateById,
    t,
  ]);

  if (groups.every((group) => group.chips.length === 0)) {
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
      {groups.map((group, index) => (
        <div
          key={group.waveId ?? `group-${index}`}
          data-testid="conductor-agent-footer-wave"
          data-wave-id={group.waveId}
          className="flex w-full min-w-0 flex-col items-start gap-0.5"
        >
          {typeof group.revisionIndex === "number" ? (
            <p
              className="text-[11px] text-muted-foreground"
              data-testid="conductor-agent-footer-wave-label"
            >
              {group.revisionIndex === 0
                ? t("conductor.wave.group.first")
                : t("conductor.wave.group.revision", {
                    count: group.revisionIndex,
                  })}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {group.chips.map((chip) => (
              <BrigadeChip key={chip.id} {...chip} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

interface ChipGroup {
  waveId?: string;
  /** Set only when this message hosts more than one wave. */
  revisionIndex?: number;
  chips: BrigadeChipViewModel[];
}

/**
 * Nodes split by the wave that spawned them, oldest wave first.
 *
 * Order is by the first node each wave produced, so the rows read down the
 * message in the order the operator watched them appear. Nodes with no
 * `waveId` — legacy hand-started orchestrators — share one trailing group,
 * because they belong to no wave and inventing one for each would turn a row
 * of three into three rows of one.
 */
function groupNodesByWave(
  nodes: readonly SessionNode[],
): Array<{ waveId?: string; nodes: SessionNode[] }> {
  const byWave = new Map<string, SessionNode[]>();
  const unowned: SessionNode[] = [];
  for (const node of nodes) {
    if (!node.waveId) {
      unowned.push(node);
      continue;
    }
    const bucket = byWave.get(node.waveId);
    if (bucket) bucket.push(node);
    else byWave.set(node.waveId, [node]);
  }
  const firstSeen = (group: readonly SessionNode[]) =>
    group.reduce(
      (earliest, node) => Math.min(earliest, node.createdAt ?? 0),
      Number.POSITIVE_INFINITY,
    );
  const groups: Array<{ waveId?: string; nodes: SessionNode[] }> = [
    ...byWave.entries(),
  ]
    .map(([waveId, waveNodes]) => ({ waveId, nodes: waveNodes }))
    .sort((left, right) => firstSeen(left.nodes) - firstSeen(right.nodes));
  if (unowned.length > 0) groups.push({ waveId: undefined, nodes: unowned });
  return groups;
}
