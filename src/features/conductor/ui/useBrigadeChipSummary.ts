/**
 * The live words on a worker's chip, from the worker's own chat.
 *
 * One subscription per chip, to that worker's runtime and messages in the
 * chat store — which is where the ACP notification handler already routes a
 * child's stream, so a worker that runs in the background still moves its
 * chip. The summary is throttled: a worker that reads twenty files a second
 * must not make its chip flicker, and the status itself is never held back,
 * because a chip that keeps saying "working" after its worker died is the
 * failure these words exist to prevent.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { toolCallLabel } from "@/features/chat/ui/ToolCallAdapter";
import {
  type AccountQuotaWait,
  useAccountQuotaWaitStore,
} from "@/features/chat/lib/accountQuotaWait";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import { useLocaleFormatting } from "@/shared/i18n";

import { isWorkingStatus } from "../brigadeActivity";
import {
  CHIP_SUMMARY_THROTTLE_MS,
  brigadeChipFacts,
  formatRunDuration,
  type BrigadeChipFacts,
} from "../brigadeChipSummary";
import { isMonitorJobLive, type MonitorJob } from "../monitorJobs";
import { useMonitorJobStore } from "../monitorJobStore";
import type { SessionNode, StructuredReport } from "../types";
import type { BrigadeGlyphStatus } from "./BrigadeChip";

export interface BrigadeChipSummary {
  status: BrigadeGlyphStatus;
  /** `12.3k · 7 tools · Reading waveEngine.ts`, or nothing yet. */
  summaryLabel?: string;
  /** Why a finished worker ended the way it did, in one line. */
  reasonLabel?: string;
}

/**
 * A value that changes at most once per `intervalMs`, holding the newest one
 * back until the interval has passed. The first value shows at once.
 */
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [shown, setShown] = useState(value);
  const lastShownAt = useRef(Date.now());
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    if (Object.is(shown, value)) return;
    const elapsed = Date.now() - lastShownAt.current;
    if (elapsed >= intervalMs) {
      lastShownAt.current = Date.now();
      setShown(value);
      return;
    }
    const timer = setTimeout(() => {
      lastShownAt.current = Date.now();
      setShown(latest.current);
    }, intervalMs - elapsed);
    return () => clearTimeout(timer);
  }, [intervalMs, shown, value]);
  return shown;
}

/**
 * The chip's line for why a run ended. A provider's refusal of too many
 * requests arrives in each bridge's own words ("exceeded retry limit, last
 * status: 429 Too Many Requests"), which the chip cut off before the part
 * that says what happened; it reads as what it is. The agent's chat keeps
 * the provider's words.
 */
export function formatBrigadeChipReason(
  reason: string | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | undefined {
  if (!reason) return undefined;
  return /\b429\b|too many requests/i.test(reason)
    ? t("conductor.chip.rateLimited")
    : reason;
}

/**
 * The chip's line for an agent whose message waits for its provider: why,
 * and when it is sent again. A burst of agents the provider refused with a
 * 429 reads as waiting, not as failed rows (LAWS/WAVES.md).
 */
export function formatProviderWait(
  wait: Pick<AccountQuotaWait, "reason" | "retryAt">,
  t: (key: string, options?: Record<string, unknown>) => string,
  formatTime: (at: number) => string,
): string {
  return t(
    wait.reason === "rate_limit"
      ? "conductor.chip.rateLimitWait"
      : "conductor.chip.quotaWait",
    { time: formatTime(wait.retryAt) },
  );
}

/** The chip's words for one set of facts. */
export function formatBrigadeChipSummary(
  facts: BrigadeChipFacts,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | undefined {
  const parts: string[] = [];
  if (facts.spendLabel) parts.push(facts.spendLabel);
  if (typeof facts.toolCount === "number" && facts.toolCount > 0) {
    parts.push(t("conductor.chip.tools", { count: facts.toolCount }));
  }
  if (facts.lastStep) {
    parts.push(
      facts.lastStep.kind === "tool"
        ? toolCallLabel(t, facts.lastStep.request).text
        : facts.lastStep.headline,
    );
  } else if (facts.durationMs !== undefined) {
    parts.push(formatRunDuration(facts.durationMs));
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function useBrigadeChipSummary(
  node: SessionNode,
  report: StructuredReport | undefined,
): BrigadeChipSummary {
  const { t } = useTranslation("chat");
  const { formatDate } = useLocaleFormatting();
  const runtime = useChatStore(
    (state) => state.sessionStateById[node.sessionId],
  );
  const providerWait = useAccountQuotaWaitStore(
    (state) => state.waits[node.sessionId],
  );
  const messages = useChatStore(
    (state) => state.messagesBySession[node.sessionId],
  );
  const facts = useMemo(
    () => brigadeChipFacts({ node, runtime, messages, report }),
    [messages, node, report, runtime],
  );
  const summaryLabel = useMemo(
    () => formatBrigadeChipSummary(facts, t),
    [facts, t],
  );
  // Only the live words are throttled. A finished run's summary is settled,
  // and the status and reason must change the moment the chat does.
  const throttled = useThrottledValue(summaryLabel, CHIP_SUMMARY_THROTTLE_MS);
  // The oldest job the agent waits on, when its own turn is over. The node is
  // already `waiting` here (`withLiveJobStatus`); this says on what.
  const job = useMonitorJobStore((state) => {
    let oldest: MonitorJob | undefined;
    for (const key in state.jobsById) {
      const candidate = state.jobsById[key];
      if (
        candidate &&
        isMonitorJobLive(candidate) &&
        candidate.ownerSessionId === node.sessionId &&
        (!oldest || candidate.startedAt < oldest.startedAt)
      ) {
        oldest = candidate;
      }
    }
    return oldest;
  });
  if (
    job &&
    facts.status === "waiting" &&
    !providerWait &&
    !(runtime && isSessionRunning(runtime.chatState))
  ) {
    return {
      status: "waiting",
      summaryLabel,
      reasonLabel: t("conductor.chip.waitingOnJob", {
        label: job.label,
        duration: formatRunDuration(Math.max(0, Date.now() - job.startedAt)),
      }),
    };
  }
  // Said the moment the queue parks the message, before the graph's own
  // pass has moved the node to waiting.
  if (
    providerWait &&
    facts.status !== "blocked" &&
    isWorkingStatus(facts.status)
  ) {
    return {
      status: "waiting",
      summaryLabel: facts.lastStep ? throttled : summaryLabel,
      reasonLabel: formatProviderWait(providerWait, t, (at) =>
        formatDate(at, { timeStyle: "medium" }),
      ),
    };
  }
  return {
    status: facts.status,
    summaryLabel: facts.lastStep ? throttled : summaryLabel,
    reasonLabel: formatBrigadeChipReason(facts.reason, t),
  };
}
