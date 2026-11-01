/**
 * What a worker's chip says beyond its name: the facts, read once from the
 * worker's own chat.
 *
 * The chip under a conductor's plan used to carry a status word and what the
 * step had spent. The harnesses people work in every day show more on the
 * same row — tokens, tool uses, the step the agent is on — and, once the
 * agent is gone, the one line that says why. These are the pure halves of
 * that: which facts the chip has, derived from the graph node, the worker's
 * live runtime and its messages, with no formatting and no clock of its own.
 */

import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import {
  type LiveActivity,
  liveActivity,
} from "@/features/chat/lib/agentWorkActivity";
import type { SessionChatRuntime } from "@/shared/types/chat";
import type { Message } from "@/shared/types/messages";

import { isWorkingStatus } from "./brigadeActivity";
import { lastFailureReason } from "./runStatus";
import type { SessionNode, StructuredReport } from "./types";
import type { BrigadeGlyphStatus } from "./ui/BrigadeChip";

/** How often a live chip's summary may change, so a busy worker's row holds still. */
export const CHIP_SUMMARY_THROTTLE_MS = 3_000;

/** A reason is one line; a chip is not the place for a paragraph. */
export const CHIP_REASON_MAX_LENGTH = 140;

export interface BrigadeChipFacts {
  /**
   * The status the chip shows. The node's own, except where the worker's chat
   * contradicts a `working` claim with a failure the graph has not caught up
   * with yet, and where a finished run's report says the step was blocked.
   */
  status: BrigadeGlyphStatus;
  /** What the step has spent, already formatted ("$0.41", "12.3k"). */
  spendLabel?: string;
  /**
   * Tool calls in the worker's chat so far. Absent when the chat's messages
   * are not loaded in this window, which is not the same as zero.
   */
  toolCount?: number;
  /** The step a working agent is on, or `null` while it writes its answer. */
  lastStep: LiveActivity | null;
  /** Wall-clock length of a finished run, when both ends were recorded. */
  durationMs?: number;
  /** Why a run that is over ended the way it did, in one line. */
  reason?: string;
}

export interface BrigadeChipFactsInput {
  node: SessionNode;
  runtime?: Pick<
    SessionChatRuntime,
    "chatState" | "tokenState" | "streamingMessageId" | "error"
  >;
  messages?: readonly Message[];
  report?: StructuredReport;
}

/** `12.3k`, `980`, `2.1M`: a token count the width of a chip. */
export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions >= 10 ? millions.toFixed(0) : millions.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (value >= 1000) {
    const thousands = value / 1000;
    return `${thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(Math.round(value));
}

/**
 * What one step has spent, or nothing at all.
 *
 * Cost wins when the provider prices its tokens, because money is the number
 * the operator is actually deciding about; tokens are the fallback for a
 * provider that reports none, and a step that has reported neither shows
 * nothing rather than a zero it has not earned.
 */
export function spendLabelFor(
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

/** `12s`, `2m 10s`, `1h 02m`: how long a run took, the way a status line counts. */
export function formatRunDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The first line of a text, cut to chip length. */
export function oneLine(text: string, limit = CHIP_REASON_MAX_LENGTH): string {
  const line =
    text
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.length > 0) ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

function countToolCalls(messages: readonly Message[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "toolRequest") count += 1;
    }
  }
  return count;
}

/**
 * A `working` node whose chat already shows the run is over and failed.
 *
 * The graph learns a child's end from a sync pass; between the bridge dying
 * and that pass, the chip would say "working" over a chat that says
 * otherwise. The chat is the closer witness: a runtime in error, or a last
 * reply the host marked failed while nothing runs, is a run that is gone.
 */
function failureBehindWorkingStatus(
  input: BrigadeChipFactsInput,
): string | undefined {
  const { runtime, messages } = input;
  if (!runtime) return undefined;
  if (runtime.chatState === "error") {
    return runtime.error?.trim() || lastFailureReason(messages) || "";
  }
  if (isSessionRunning(runtime.chatState)) return undefined;
  if (runtime.streamingMessageId) return undefined;
  return lastFailureReason(messages) ?? undefined;
}

export function brigadeChipFacts(
  input: BrigadeChipFactsInput,
): BrigadeChipFacts {
  const { node, runtime, messages, report } = input;
  const spendLabel = spendLabelFor(runtime?.tokenState);
  const toolCount = messages ? countToolCalls(messages) : undefined;

  if (isWorkingStatus(node.status)) {
    const failure = failureBehindWorkingStatus(input);
    if (failure !== undefined) {
      return {
        status: "failed",
        spendLabel,
        toolCount,
        lastStep: null,
        ...(failure ? { reason: oneLine(failure) } : {}),
      };
    }
    const streaming =
      runtime?.streamingMessageId && messages
        ? messages.find((message) => message.id === runtime.streamingMessageId)
        : undefined;
    return {
      status: node.status,
      spendLabel,
      toolCount,
      lastStep: liveActivity(streaming?.content),
    };
  }

  const durationMs =
    typeof node.createdAt === "number" && typeof node.finishedAt === "number"
      ? Math.max(0, node.finishedAt - node.createdAt)
      : undefined;
  const status: BrigadeGlyphStatus =
    node.status === "completed" && report?.status === "blocked"
      ? "blocked"
      : node.status;
  const reason = terminalReason(status, input);
  return {
    status,
    spendLabel,
    toolCount,
    lastStep: null,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(reason ? { reason: oneLine(reason) } : {}),
  };
}

/**
 * The one line a finished chip repeats about why it finished that way.
 *
 * A failure quotes the host — the reply's own reason survives a reload, the
 * runtime's error does not — and falls back to the report's summary, which
 * for a run that failed without a fence is the worker's last words. A
 * blocked step quotes the worker's reason. A stop or a cancel says nothing
 * beyond its status word: the operator asked for it, and the chip has no
 * better account of why than they do.
 */
function terminalReason(
  status: BrigadeGlyphStatus,
  { node, runtime, messages, report }: BrigadeChipFactsInput,
): string | undefined {
  // A stop the app made says why it made it; the operator's own stop says so
  // too, which beats a bare status word the operator has to remember causing.
  if (status === "cancelled" || status === "stopped") return node.stopReason;
  if (status === "failed") {
    return (
      lastFailureReason(messages) ??
      runtime?.error?.trim() ??
      (report?.status === "failed" ? report.summary : undefined)
    );
  }
  if (status === "blocked") {
    return report?.reason ?? report?.summary;
  }
  return undefined;
}
