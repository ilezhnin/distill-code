import { IconPlayerPause, IconPlayerStop } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/shared/lib/cn";
import { ActiveChatPulseDot } from "@/shared/ui/SessionActivityIndicator";

import { isWorkingStatus } from "../brigadeActivity";
import type { RunStatus } from "../types";

const STATUS_DOT_CLASS: Record<RunStatus, string> = {
  starting: "bg-info",
  running: "bg-info",
  waiting: "bg-warning",
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground",
  stopped: "bg-muted-foreground",
};

/**
 * Everything a brigade chip needs to render, with no session attached: graph
 * children, ephemeral harness subagents and placeholders all project into this
 * shape.
 *
 * `id` (not `key`) carries the identity, because React strips a `key` prop
 * before the component ever sees it. Callers spread the view model and pass
 * `key={vm.id}` alongside.
 */
export interface BrigadeChipViewModel {
  /** Stable identity; handed back to `onOpen`/`onStop`. */
  id: string;
  /** Chip label. */
  name: string;
  status: RunStatus;
  /** Hover tooltip; falls back to the localized status label. */
  title?: string;
  /** Omitted → the chip is not clickable. */
  onOpen?: (id: string) => void;
  /** Omitted → no stop button, whatever the status. */
  onStop?: (id: string) => void;
}

export interface BrigadeChipProps extends BrigadeChipViewModel {
  className?: string;
}

/**
 * Exported so surfaces that show the same run statuses without a whole chip —
 * the child-chat tab strip — read from one status vocabulary.
 */
export function BrigadeStatusGlyph({ status }: { status: RunStatus }) {
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

export function BrigadeChip({
  id,
  name,
  status,
  title,
  onOpen,
  onStop,
  className,
}: BrigadeChipProps) {
  const { t } = useTranslation("chat");
  const statusLabel = t(`conductor.status.${status}`);
  const showStop = Boolean(onStop) && isWorkingStatus(status);

  return (
    <span
      data-testid="brigade-chip"
      data-status={status}
      className={cn("inline-flex items-center gap-1", className)}
    >
      <button
        type="button"
        data-testid="conductor-agent-chip"
        aria-label={t("conductor.openChild", { name, status: statusLabel })}
        title={title || statusLabel}
        onClick={onOpen ? () => onOpen(id) : undefined}
        className="inline-flex items-center gap-1.5 rounded-full text-xs text-muted-foreground hover:text-foreground"
      >
        <BrigadeStatusGlyph status={status} />
        <span className="font-medium text-foreground">{name}</span>
      </button>
      {showStop && onStop ? (
        <button
          type="button"
          data-testid="conductor-agent-stop"
          aria-label={t("conductor.stopChild", { name })}
          onClick={() => onStop(id)}
          className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <IconPlayerStop className="size-3" />
        </button>
      ) : null}
    </span>
  );
}
