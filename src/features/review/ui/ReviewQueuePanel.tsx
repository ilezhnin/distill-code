/**
 * "While you were away."
 *
 * The panel that answers the question a person asks when they come back to a
 * machine that was working without them, and that until now could only be
 * answered by opening every conductor chat in turn.
 *
 * It renders nothing at all when nothing has finished. An empty panel here
 * would be a permanent piece of furniture reporting an absence, and the home
 * screen already has a job.
 */

import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { IconAlertTriangle, IconCheck, IconX } from "@tabler/icons-react";

import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

import {
  buildReviewQueue,
  withConductorNames,
  type ReviewItem,
} from "../lib/reviewQueue";
import { useReviewSeenStore } from "../stores/reviewSeenStore";

export function ReviewQueuePanel({
  onOpenSession,
  className,
}: {
  onOpenSession: (sessionId: string) => void;
  className?: string;
}) {
  const { t } = useTranslation("review");
  const nodesById = useConductorGraphStore((state) => state.nodesById);
  const reportsByRunId = useConductorGraphStore(
    (state) => state.reportsByRunId,
  );
  const sessions = useChatSessionStore((state) => state.sessions);
  const lastSeenAt = useReviewSeenStore((state) => state.lastSeenAt);
  const markSeen = useReviewSeenStore((state) => state.markSeen);

  const items = useMemo(() => {
    const built = buildReviewQueue({
      nodes: Object.values(nodesById),
      reportOf: (runId) => reportsByRunId[runId],
      lastSeenAt,
    });
    return withConductorNames(
      built,
      (sessionId) => sessions.find((s) => s.id === sessionId)?.title,
      t("unknownConductor"),
    );
  }, [lastSeenAt, nodesById, reportsByRunId, sessions, t]);

  const dismiss = useCallback(() => markSeen(), [markSeen]);

  if (items.length === 0) return null;

  return (
    <section
      className={cn("flex w-full flex-col gap-2", className)}
      data-testid="review-queue"
      aria-label={t("title")}
    >
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">{t("title")}</h2>
        <Button
          type="button"
          variant="ghost"
          size="xxs"
          className="ml-auto"
          onClick={dismiss}
          data-testid="review-dismiss"
        >
          {t("dismiss")}
        </Button>
      </div>
      <ul className="flex list-none flex-col gap-1">
        {items.map((item) => (
          <ReviewRow key={item.sessionId} item={item} onOpen={onOpenSession} />
        ))}
      </ul>
    </section>
  );
}

function ReviewRow({
  item,
  onOpen,
}: {
  item: ReviewItem;
  onOpen: (sessionId: string) => void;
}) {
  const { t } = useTranslation("review");
  const Icon =
    item.outcome === "needsOperator"
      ? IconAlertTriangle
      : item.outcome === "failed"
        ? IconX
        : IconCheck;

  return (
    <li data-testid="review-item" data-outcome={item.outcome}>
      <button
        type="button"
        onClick={() => onOpen(item.sessionId)}
        className="flex w-full items-start gap-2 rounded-md bg-accent px-2 py-1.5 text-left hover:bg-accent/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Icon
          className={cn(
            "mt-0.5 size-4 shrink-0",
            item.outcome === "needsOperator" && "text-warning",
            item.outcome === "failed" && "text-destructive",
            item.outcome === "completed" && "opacity-60",
          )}
          aria-hidden
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">
              {item.displayName}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {t(`outcome.${item.outcome}`, {
                needsOperator: item.needsOperator,
                failed: item.failed,
                completed: item.completed,
              })}
            </span>
          </span>
          {item.summary ? (
            <span
              className="line-clamp-2 text-xs text-muted-foreground"
              data-testid="review-summary"
            >
              {item.summary}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
