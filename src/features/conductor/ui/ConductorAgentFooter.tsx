import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { useChatStore } from "@/features/chat/stores/chatStore";
import { useTranscriptRowStateAdapter } from "@/features/chat/transcript/row-state";
import { cn } from "@/shared/lib/cn";
import { splitLegacyFoldedModelId } from "@/shared/lib/foldedModelId";
import type { SessionChatRuntime } from "@/shared/types/chat";
import { DisclosureLine } from "@/shared/ui/ai-elements/disclosure-line";

import type { ConductorOpenChildIntent } from "../ConductorTranscriptContext";
import { isWorkingStatus, summarizeBrigadeActivity } from "../brigadeActivity";
import { formatTokenCount } from "../brigadeChipSummary";
import { pendingStepName, waveFooterRow } from "../waveFooterChips";
import { waveStepAccessKey } from "../flockConductorTranscript";
import type { WaveStep } from "../flockWave";
import type { SessionNode, StructuredReport } from "../types";
import { BrigadeChip, type BrigadeChipViewModel } from "./BrigadeChip";
import { useBrigadeChipSummary } from "./useBrigadeChipSummary";

/**
 * A chip for a real worker: the view model the row built, plus the live words
 * its own chat supplies — tokens, tool count, the step it is on, and the one
 * line that says why it stopped. Each chip subscribes to its own worker so a
 * row of five does not re-render on every token of every worker.
 */
function GraphBrigadeChip({
  node,
  report,
  ...chip
}: BrigadeChipViewModel & { node: SessionNode; report?: StructuredReport }) {
  const live = useBrigadeChipSummary(node, report);
  return (
    <BrigadeChip
      {...chip}
      status={live.status}
      summaryLabel={live.summaryLabel}
      reasonLabel={live.reasonLabel}
    />
  );
}

/**
 * What a step's chip says about how the plan asked it to run: the model, the
 * effort and fast mode, as separate words.
 *
 * A legacy model string with its effort inside the name is shown split, the
 * way the spawn runs it, so the chip never displays an id no harness lists and
 * the operator sees the effort the step actually asked for. The step's own
 * `effort` wins over the one in the name, as it does at the spawn.
 */
function waveStepChipModelLabel(
  step: WaveStep | undefined,
  fastLabel: string,
): string | undefined {
  if (!step) return undefined;
  const folded = step.model ? splitLegacyFoldedModelId(step.model) : null;
  const parts = [
    folded ? folded.modelId : step.model,
    step.effort ?? folded?.effort,
    step.fast ? fastLabel : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : undefined;
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
  workingListedBelow = false,
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
  /**
   * The line above the composer is listing every working agent of this chat,
   * with the same live words and controls. The row then draws only the
   * finished ones and says how many it left to that list, instead of the
   * same agents appearing twice one above the other.
   */
  workingListedBelow?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const sessionStateById = useChatStore((state) => state.sessionStateById);
  const { rowState, updateRowState, markRowInteracted, pinScrollAnchor } =
    useTranscriptRowStateAdapter();

  const stats = useMemo(() => {
    const { working, done } = summarizeBrigadeActivity(nodes);
    const parts: string[] = [];
    if (working > 0) {
      parts.push(t("conductor.statsWorking", { count: working }));
    }
    if (done > 0) {
      parts.push(t("conductor.statsDone", { count: done }));
    }
    const sessionIds = nodes.map((node) => node.sessionId);
    if (hostSessionId) sessionIds.unshift(hostSessionId);
    parts.push(...spendParts(sumSpend(sessionStateById, sessionIds), t));
    return parts.join(" · ");
  }, [hostSessionId, nodes, sessionStateById, t]);

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
    const chipForNode = (node: SessionNode): FooterChip => {
      const report = node.runId ? reportsByRunId[node.runId] : undefined;
      const step =
        typeof node.stepIndex === "number"
          ? planSteps?.[node.stepIndex]
          : undefined;
      return {
        node,
        report,
        id: node.sessionId,
        name: node.displayName,
        status: node.status,
        title: report?.summary || node.task || undefined,
        stepIndex: node.stepIndex,
        accessLabel: step ? t(waveStepAccessKey(step)) : undefined,
        // D5: a step the plan pinned to a model wears it on the chip, with the
        // effort and fast mode it asked for. The plan's words, deliberately —
        // the chip states the instruction; what it resolved to is on the
        // child tab and in the spawn notices.
        modelLabel: waveStepChipModelLabel(step, t("conductor.chipFast")),
        onOpen: openInTab,
        onStop,
      };
    };

    const rowFor = (
      forNodes: readonly SessionNode[],
      steps: readonly WaveStep[] | undefined,
    ): FooterChip[] => {
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
                modelLabel: waveStepChipModelLabel(
                  slot.step,
                  t("conductor.chipFast"),
                ),
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
  }, [nodes, onStop, openInTab, planSteps, reportsByRunId, t]);

  // A conductor that keeps revising hangs every wave under the one plan
  // message, and thirty revisions of five chips each was three screens of
  // finished work between the operator and the conversation. Only the newest
  // waves stay drawn; the older finished ones fold into one line that says
  // how many there were, how they ended and what they cost. A wave with
  // anything still working never folds, wherever it sits.
  const fold = useMemo(() => {
    if (groups.length <= VISIBLE_WAVE_GROUPS) return null;
    const keepFrom = groups.length - VISIBLE_WAVE_GROUPS;
    const folded: ChipGroup[] = [];
    const shown: ChipGroup[] = [];
    groups.forEach((group, index) => {
      if (index >= keepFrom || groupIsActive(group)) shown.push(group);
      else folded.push(group);
    });
    if (folded.length === 0) return null;
    const foldedNodes = folded.flatMap((group) =>
      group.chips.flatMap((chip) => (chip.node ? [chip.node] : [])),
    );
    const { done } = summarizeBrigadeActivity(foldedNodes);
    const notDone = foldedNodes.length - done;
    const parts = [t("conductor.wave.group.earlier", { count: folded.length })];
    if (done > 0) parts.push(t("conductor.statsDone", { count: done }));
    if (notDone > 0) {
      parts.push(t("conductor.wave.group.notDone", { count: notDone }));
    }
    parts.push(
      ...spendParts(
        sumSpend(
          sessionStateById,
          foldedNodes.map((node) => node.sessionId),
        ),
        t,
      ),
    );
    return { folded, shown, label: parts.join(" · ") };
  }, [groups, sessionStateById, t]);

  // Durable on the transcript row, so an opened fold stays open when the row
  // scrolls out of the virtualized viewport and back.
  const foldStateKey = `conductorEarlierWaves:${groups[0]?.waveId ?? "row"}`;
  const [foldOpen, setFoldOpenState] = useState(
    () => rowState?.custom?.[foldStateKey] === true,
  );
  const setFoldOpen = (open: boolean) => {
    markRowInteracted("conductor-earlier-waves");
    pinScrollAnchor();
    setFoldOpenState(open);
    updateRowState((current) => ({
      ...current,
      custom: { ...current.custom, [foldStateKey]: open },
    }));
  };

  if (groups.every((group) => group.chips.length === 0)) {
    return null;
  }

  const renderGroup = (group: ChipGroup, index: number) => {
    const chips = workingListedBelow
      ? group.chips.filter(
          (chip) => !(chip.node && isWorkingStatus(chip.node.status)),
        )
      : group.chips;
    const listedBelow = group.chips.length - chips.length;
    return (
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
          {chips.map(({ node, report, ...chip }) =>
            node ? (
              <GraphBrigadeChip
                key={chip.id}
                {...chip}
                node={node}
                report={report}
              />
            ) : (
              <BrigadeChip key={chip.id} {...chip} />
            ),
          )}
          {listedBelow > 0 ? (
            <span
              className="text-xs text-muted-foreground"
              data-testid="conductor-working-listed-below"
            >
              {t("conductor.wave.group.workingBelow", { count: listedBelow })}
            </span>
          ) : null}
        </div>
      </div>
    );
  };

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
      {fold ? (
        <>
          <DisclosureLine
            open={foldOpen}
            onOpenChange={setFoldOpen}
            className="w-full min-w-0"
            label={
              <span
                className="text-xs text-muted-foreground tabular-nums"
                data-testid="conductor-earlier-waves"
              >
                {fold.label}
              </span>
            }
          >
            <div className="flex w-full min-w-0 flex-col items-start gap-1 pt-1">
              {fold.folded.map(renderGroup)}
            </div>
          </DisclosureLine>
          {fold.shown.map(renderGroup)}
        </>
      ) : (
        groups.map(renderGroup)
      )}
    </div>
  );
}

/** How many of the newest waves a footer always draws in full. */
const VISIBLE_WAVE_GROUPS = 3;

/** A wave the operator is still waiting on: a step not started or not done. */
function groupIsActive(group: ChipGroup): boolean {
  return group.chips.some(
    (chip) => chip.pending || (chip.node && isWorkingStatus(chip.node.status)),
  );
}

interface Spend {
  tokens: number;
  cost: number;
  hasCost: boolean;
}

/** Tokens and cost the given sessions have run up, as their chats report. */
function sumSpend(
  sessionStateById: Readonly<Record<string, SessionChatRuntime | undefined>>,
  sessionIds: readonly string[],
): Spend {
  const spend: Spend = { tokens: 0, cost: 0, hasCost: false };
  for (const sessionId of sessionIds) {
    const tokenState = sessionStateById[sessionId]?.tokenState;
    if (!tokenState) continue;
    spend.tokens += tokenState.accumulatedTotal;
    if (typeof tokenState.accumulatedCost === "number") {
      spend.cost += tokenState.accumulatedCost;
      spend.hasCost = true;
    }
  }
  return spend;
}

function spendParts(spend: Spend, t: TFunction<"chat">): string[] {
  const parts: string[] = [];
  if (spend.tokens > 0) {
    parts.push(
      t("conductor.statsTokens", { tokens: formatTokenCount(spend.tokens) }),
    );
  }
  if (spend.hasCost && spend.cost > 0) {
    parts.push(t("conductor.statsCost", { cost: spend.cost.toFixed(2) }));
  }
  return parts;
}

/** A chip in the row, with the worker behind it when one exists. */
interface FooterChip extends BrigadeChipViewModel {
  /** Absent for a step the plan promised that nothing has spawned yet. */
  node?: SessionNode;
  report?: StructuredReport;
}

interface ChipGroup {
  waveId?: string;
  /** Set only when this message hosts more than one wave. */
  revisionIndex?: number;
  chips: FooterChip[];
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
