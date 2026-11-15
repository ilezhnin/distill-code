import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { HarnessBrigadeEntry } from "@/features/chat/lib/harnessBrigade";
import { revealHarnessSubagentToolCall } from "@/features/chat/lib/harnessBrigadeFocus";
import { isWorkingStatus } from "@/features/conductor/brigadeActivity";
import {
  formatRunDuration,
  formatTokenCount,
} from "@/features/conductor/brigadeChipSummary";
import { BrigadeChip } from "@/features/conductor/ui/BrigadeChip";
import { cn } from "@/shared/lib/cn";

/** What one in-harness subagent's chip says. */
export interface HarnessChipWords {
  /** What the subagent does when the call said, else who it is. */
  name: string;
  /** Who it is, beside a name that says what it does. */
  kindLabel?: string;
  /** Its running time while it works; what it spent once it is done. */
  summaryLabel?: string;
  /** The tooltip: the task and the agent, each on its own line. */
  title?: string;
}

/**
 * The words on one chip.
 *
 * A chip used to lead with the agent the harness named. For a configured
 * agent that is a name; for most calls it is only a kind, and six subagents
 * started in one turn read `fork fork fork fork fork fork` — the task each
 * was given was in the tooltip, and nothing said how long one had run or
 * what it cost. The task leads now, the kind stands beside it, a working
 * chip counts its time, and a finished one says what its result reports.
 */
export function harnessChipWords(
  entry: HarnessBrigadeEntry,
  t: (key: string, options?: Record<string, unknown>) => string,
  now: number,
): HarnessChipWords {
  const task = entry.label?.trim() || undefined;
  const agent = entry.agentName?.trim() || undefined;
  const name = task ?? agent ?? entry.name ?? t("harnessBrigade.fallbackName");
  const parts: string[] = [];
  if (isWorkingStatus(entry.status)) {
    if (entry.startedAt !== undefined && now >= entry.startedAt) {
      parts.push(formatRunDuration(now - entry.startedAt));
    }
  } else if (entry.usage) {
    const { tokens, toolUses, durationMs } = entry.usage;
    if (tokens) parts.push(formatTokenCount(tokens));
    if (toolUses) parts.push(t("conductor.chip.tools", { count: toolUses }));
    if (durationMs) parts.push(formatRunDuration(durationMs));
  }
  const title = [task, agent && agent !== name ? agent : undefined]
    .filter(Boolean)
    .join("\n");
  return {
    name,
    ...(task && agent && agent !== task ? { kindLabel: agent } : {}),
    ...(parts.length > 0 ? { summaryLabel: parts.join(" · ") } : {}),
    ...(title ? { title } : {}),
  };
}

/** A clock that moves once a second, and only while something is counted. */
function useRunningClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * The chip row for in-harness subagents — live under the steps while the turn
 * streams, and permanently under the finished answer.
 *
 * These agents have no session: the chips carry no stop button, and opening
 * one reveals its tool call instead of navigating to a chat that does not
 * exist.
 */
export function HarnessBrigadeRow({
  entries,
  className,
}: {
  entries: readonly HarnessBrigadeEntry[];
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const toolCallIdByKey = useMemo(
    () => new Map(entries.map((entry) => [entry.key, entry.latestToolCallId])),
    [entries],
  );
  const handleOpen = useCallback(
    (key: string) => {
      const toolCallId = toolCallIdByKey.get(key);
      if (toolCallId) revealHarnessSubagentToolCall(toolCallId);
    },
    [toolCallIdByKey],
  );
  const now = useRunningClock(
    entries.some(
      (entry) => entry.startedAt !== undefined && isWorkingStatus(entry.status),
    ),
  );

  if (entries.length === 0) return null;

  return (
    <ul
      data-testid="harness-brigade-row"
      className={cn(
        "flex w-full min-w-0 list-none flex-wrap items-center gap-x-3 gap-y-1",
        className,
      )}
      aria-label={t("harnessBrigade.label")}
    >
      {entries.map((entry) => (
        <li key={entry.key} className="flex min-w-0 items-center">
          <BrigadeChip
            id={entry.key}
            status={entry.status}
            onOpen={handleOpen}
            {...harnessChipWords(entry, t, now)}
          />
        </li>
      ))}
    </ul>
  );
}
