import type { CompactionUpdate, ContentBlock } from "@agentclientprotocol/sdk";
import { ChevronDown, CircleStop, CircleX, FoldVertical } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createVirtualLayoutStabilityAttributes,
  useVirtualLayoutPendingForChange,
} from "@/features/chat/transcript/measurement";
import { useTranscriptRowStateAdapter } from "@/features/chat/transcript/row-state";
import { formatTokenCount } from "@/features/conductor/brigadeChipSummary";
import { cn } from "@/shared/lib/cn";
import { isRecord } from "@/shared/lib/isRecord";
import { useWorkingIndicatorAnimationPreference } from "@/shared/preferences/workingIndicatorAnimationPreference";
import type { CompactionMeasure } from "@/shared/types/messages";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import { Shimmer } from "@/shared/ui/ai-elements/shimmer";
import { Button } from "@/shared/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
import { FlockDart } from "@/shared/ui/flock-dart";
import { useRunningClock } from "../hooks/useRunningClock";
import { ClickableImage } from "./ClickableImage";
import { formatWorkingTime } from "./LoadingFlock";
import { resolveImageContentSrc } from "./resolveImageContentSrc";

/** How long the figure and the meter take to settle once a compaction ends. */
const SETTLE_MS = 700;
const COMPACTING_SHIMMER_PROPS = {
  continuous: true,
  duration: 2.2,
  spread: 2.5,
  tone: "strong",
} as const;
const TRIGGERS = ["automatic", "manual", "idle"] as const;

function SummaryBlock({ block }: { block: ContentBlock }) {
  if (block.type === "text")
    return <MessageResponse>{block.text}</MessageResponse>;
  if (block.type === "image") {
    const src = resolveImageContentSrc(block, () => false);
    return src ? <ClickableImage src={src} alt={block.mimeType} /> : null;
  }
  if (block.type === "resource" && "text" in block.resource) {
    return <MessageResponse>{block.resource.text}</MessageResponse>;
  }
  // Keep opaque content identifiable without treating arbitrary resource URIs as executable links.
  return (
    <span className="text-xs text-muted-foreground">
      {block.type === "resource_link"
        ? (block.title ?? block.name)
        : block.type === "resource"
          ? block.resource.uri
          : block.mimeType}
    </span>
  );
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * What the bridge itself says a compaction did, when it says: only
 * claude-agent-acp does, as `_meta.jetbrains.air.contextCompaction`.
 */
function bridgeFacts(compaction: CompactionUpdate) {
  const jetbrains = compaction._meta?.jetbrains;
  const air = isRecord(jetbrains) ? jetbrains.air : undefined;
  const facts = isRecord(air) ? air.contextCompaction : undefined;
  if (!isRecord(facts)) return {};
  return {
    before: finite(facts.preTokens),
    after: finite(facts.postTokens),
    durationMs: finite(facts.durationMs),
    trigger: TRIGGERS.find((trigger) => trigger === facts.trigger),
  };
}

/**
 * A figure that runs from where it was to where it settled, once, when the
 * change is seen happening. A figure met already settled stands still.
 */
function useRolledFigure(
  value: number | undefined,
  from: number | undefined,
  roll: boolean,
): number | undefined {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (value === undefined || from === undefined || !roll) {
      setShown(value);
      return;
    }
    const startedAt = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const progress = Math.min(1, (now - startedAt) / SETTLE_MS);
      setShown(Math.round(from + (value - from) * (1 - (1 - progress) ** 3)));
      if (progress < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [value, from, roll]);
  return shown;
}

/**
 * The line a compaction leaves in the transcript. Everything above it the
 * agent now holds only as a summary, so it is drawn as the boundary it is: a
 * word for what happened, the context window before and after, how long it
 * took, and under them a hairline that measures the window, full while the
 * compaction runs and drawn back to what was kept once it ends. The summary,
 * for a bridge that shares one, opens under the line.
 */
export function CompactionNotice({
  compaction,
  measure,
}: {
  compaction: CompactionUpdate;
  measure?: CompactionMeasure;
}) {
  const { t } = useTranslation("chat");
  const summaryId = useId();
  const reducedMotion = useReducedMotion();
  const animationPreference = useWorkingIndicatorAnimationPreference();
  const motionEnabled = animationPreference.enabled && !reducedMotion;
  const { status } = compaction;
  const running = status === "in_progress";
  const completed = status === "completed";

  const facts = bridgeFacts(compaction);
  const before = facts.before ?? measure?.usedBefore;
  const settled = facts.after ?? measure?.usedAfter;
  // A window that did not shrink says nothing about the compaction.
  const after =
    completed && before !== undefined && settled !== undefined
      ? settled < before
        ? settled
        : undefined
      : undefined;
  const durationMs =
    facts.durationMs ??
    (measure?.startedAt !== undefined && measure.endedAt !== undefined
      ? measure.endedAt - measure.startedAt
      : undefined);
  const now = useRunningClock(running && measure?.startedAt !== undefined);
  const seconds = running
    ? measure?.startedAt !== undefined
      ? (now - measure.startedAt) / 1000
      : undefined
    : durationMs !== undefined
      ? durationMs / 1000
      : undefined;
  const time =
    seconds !== undefined && seconds >= 1 ? formatWorkingTime(seconds) : null;

  // The effects belong to a compaction seen ending, not to one found ended
  // when its row scrolls into view.
  const ranRef = useRef(running);
  if (running) ranRef.current = true;
  const settling = ranRef.current && completed && motionEnabled;
  const shownAfter = useRolledFigure(after, before, settling);

  // The meter is the context window when its size is known, and otherwise
  // the context as it stood before, which then fills it.
  const scale =
    measure?.size !== undefined &&
    before !== undefined &&
    measure.size >= before
      ? measure.size
      : before;
  const share = (value: number | undefined) =>
    value !== undefined && scale ? Math.max(0.015, value / scale) : undefined;
  const beforeShare = share(before);
  const fillShare = running
    ? (beforeShare ?? 1)
    : completed
      ? (share(after) ?? 0)
      : (beforeShare ?? 0);

  const hasSummary = (compaction.summary?.length ?? 0) > 0;
  const { rowState, updateRowState, markRowInteracted, pinScrollAnchor } =
    useTranscriptRowStateAdapter();
  const stateKey = `compaction:${compaction.compactionId}`;
  const [open, setOpen] = useState(
    () => rowState?.reasoningBlocks?.[stateKey]?.open ?? false,
  );
  const isLayoutPending = useVirtualLayoutPendingForChange(open);
  const toggle = (next: boolean) => {
    markRowInteracted(`reasoning:${stateKey}`);
    pinScrollAnchor();
    updateRowState(
      (current) => ({
        ...current,
        reasoningBlocks: {
          ...current.reasoningBlocks,
          [stateKey]: {
            ...current.reasoningBlocks?.[stateKey],
            open: next,
            userControlled: true,
          },
        },
      }),
      { markRecent: true },
    );
    setOpen(next);
  };

  const label = running
    ? t("loading.compacting")
    : completed
      ? t("compaction.done")
      : status === "failed"
        ? t("notifications.compactionFailed")
        : status === "cancelled"
          ? t("notifications.compactionCancelled")
          : t("notifications.compactionStatus", { status });
  const tokens =
    before === undefined
      ? null
      : running
        ? formatTokenCount(before)
        : shownAfter !== undefined
          ? `${formatTokenCount(before)} → ${formatTokenCount(shownAfter)}`
          : null;
  const tokensTitle =
    before === undefined
      ? undefined
      : after !== undefined
        ? t("compaction.freed", {
            before: formatTokenCount(before),
            after: formatTokenCount(after),
          })
        : t("compaction.tokens", { tokens: formatTokenCount(before) });
  // What a screen reader hears: the state and what it did to the context,
  // without the clock, which would be read out every second.
  const spoken =
    completed && before !== undefined && after !== undefined
      ? t("compaction.doneSpoken", {
          before: formatTokenCount(before),
          after: formatTokenCount(after),
        })
      : completed
        ? t("notifications.compactionComplete")
        : label;
  const details = [
    tokens ? (
      <span key="tokens" title={tokensTitle}>
        {tokens}
      </span>
    ) : null,
    time ? (
      <span key="time" className={cn(running && "flock-readout-accent")}>
        {time}
      </span>
    ) : null,
    facts.trigger && !running ? (
      <span key="trigger">{t(`compaction.trigger.${facts.trigger}`)}</span>
    ) : null,
  ].filter((part) => part !== null);

  return (
    <Collapsible
      open={hasSummary && open}
      onOpenChange={toggle}
      className="not-prose mb-4 min-w-0"
      data-role="compaction-notice"
      data-status={status}
    >
      <span className="sr-only" role="status">
        {spoken}
      </span>
      <div className="flex h-5 min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <span
          aria-hidden="true"
          className="flex w-4 shrink-0 items-center justify-center"
        >
          {running ? (
            <FlockDart active animated={motionEnabled} />
          ) : status === "failed" ? (
            <CircleX className="size-3.5 text-destructive" />
          ) : status === "cancelled" ? (
            <CircleStop className="size-3.5" />
          ) : (
            <FoldVertical className="size-3.5" />
          )}
        </span>
        <span
          aria-hidden="true"
          title={completed ? t("notifications.compactionComplete") : undefined}
          className={cn(
            "min-w-0 shrink truncate",
            status === "failed" && "text-destructive",
            settling && "animate-in fade-in-0 duration-500",
          )}
        >
          {running && motionEnabled ? (
            <Shimmer {...COMPACTING_SHIMMER_PROPS}>{label}</Shimmer>
          ) : (
            label
          )}
        </span>
        {details.length > 0 ? (
          <span
            aria-hidden="true"
            className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums"
          >
            {details.map((part) => (
              <span key={part.key} className="flex items-center gap-1.5">
                <span className="opacity-50">{"·"}</span>
                {part}
              </span>
            ))}
          </span>
        ) : null}
        {hasSummary ? (
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              flush
              size="xxs"
              className="shrink-0"
              aria-controls={summaryId}
              rightIcon={
                <ChevronDown
                  aria-hidden="true"
                  className={cn("transition-transform", open && "rotate-180")}
                />
              }
            >
              {t("compaction.summary")}
            </Button>
          </CollapsibleTrigger>
        ) : null}
      </div>
      <div
        aria-hidden="true"
        data-role="compaction-meter"
        className="relative mt-1.5 h-0.5 overflow-hidden rounded-full bg-muted-foreground/20"
      >
        {beforeShare !== undefined ? (
          // What the compaction freed: uncovered as the fill draws back,
          // then gone.
          <span
            className={cn(
              "absolute inset-y-0 left-0 rounded-full bg-info transition-opacity ease-out",
              running ? "opacity-50 duration-0" : "opacity-0 duration-[1800ms]",
            )}
            style={{ width: `${beforeShare * 100}%` }}
          />
        ) : null}
        <span
          data-role="compaction-meter-fill"
          className={cn(
            "absolute inset-y-0 left-0 overflow-hidden rounded-full transition-[width,background-color] ease-out",
            running
              ? beforeShare === undefined
                ? "bg-info/40"
                : "bg-info"
              : status === "failed"
                ? "bg-destructive"
                : "bg-muted-foreground",
          )}
          style={{
            width: `${fillShare * 100}%`,
            transitionDuration: `${SETTLE_MS}ms`,
          }}
        >
          {running ? (
            <span
              className="flock-meter-shine absolute inset-0"
              data-animated={motionEnabled ? "true" : "false"}
            />
          ) : null}
        </span>
      </div>
      {compaction.error ? (
        <p className="mt-1.5 break-words text-xs text-destructive">
          {compaction.error}
        </p>
      ) : null}
      {hasSummary ? (
        <CollapsibleContent
          id={summaryId}
          className="mt-3 space-y-2 text-sm text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:animate-in data-[state=open]:slide-in-from-top-2"
          {...createVirtualLayoutStabilityAttributes({
            isPending: isLayoutPending,
            reason: "reasoning-animation",
          })}
        >
          {compaction.summary?.map((block, index) => (
            // Blocks form an append-only stream until a complete replacement arrives.
            // biome-ignore lint/suspicious/noArrayIndexKey: ACP content blocks have no identity.
            <SummaryBlock key={index} block={block} />
          ))}
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}
