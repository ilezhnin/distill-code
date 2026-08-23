import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { HarnessBrigadeEntry } from "@/features/chat/lib/harnessBrigade";
import { revealHarnessSubagentToolCall } from "@/features/chat/lib/harnessBrigadeFocus";
import { BrigadeChip } from "@/features/conductor/ui/BrigadeChip";
import { cn } from "@/shared/lib/cn";

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
            name={entry.name ?? t("harnessBrigade.fallbackName")}
            status={entry.status}
            title={entry.label}
            onOpen={handleOpen}
          />
        </li>
      ))}
    </ul>
  );
}
