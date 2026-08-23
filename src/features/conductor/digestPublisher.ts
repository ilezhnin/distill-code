/**
 * Digest publication for graph children that are **not** part of a wave.
 *
 * Legacy orchestrator trees (`managedBy: "ui"`, still in operators'
 * localStorage) and children registered from outside the UI
 * (`managedBy: "agent-cli"`) reach their parent through the same envelope a
 * wave uses: one real user message, delivered through the berdctl cross-session
 * seam, grouped exactly as `publishGroups.ts` has always grouped them
 * (`parentSessionId` + `anchorMessageId`).
 *
 * This is what `publishCompletedTurns` used to be, with the one change that is
 * the whole point of 3a: it no longer appends a synthetic assistant message
 * that the parent's model never sees. There are not two publication mechanisms
 * any more — waves are published by `waveLifecycle.ts`, everything else here,
 * and both go through `deliverEnvelope`.
 *
 * `report.publishedToParent` is the idempotency flag, set before the send for
 * the same reason it is in the wave path: a double delivery corrupts the
 * parent's context, a lost one is visible in a notice.
 */

import { useChatStore } from "@/features/chat/stores/chatStore";
import { createSystemNotificationMessage } from "@/shared/types/messages";

import { useConductorGraphStore } from "./conductorGraphStore";
import { deliverEnvelope } from "./digestDelivery";
import { groupPublishableTurns } from "./publishGroups";
import type { SessionNode, StructuredReport } from "./types";
import { buildGroupDigest, type DigestEntry } from "./waveDigest";
import { digestDeliveryFailureText } from "./waveNotices";

/** Group keys whose delivery is in flight in this process. */
const inFlightGroups = new Set<string>();

function isWorkingStatus(status: SessionNode["status"]): boolean {
  return status === "starting" || status === "running" || status === "waiting";
}

/**
 * Delivers one digest per finished non-wave group.
 *
 * Called from the app-wide conductor sync on every store change, so it must be
 * cheap and idempotent: the persisted `publishedToParent` flag covers restarts,
 * the in-flight set covers the async window inside one process.
 */
export function publishTerminalGroupDigests(
  workersOf: (parentSessionId: string) => readonly SessionNode[],
): void {
  const graph = useConductorGraphStore.getState();
  const groups = groupPublishableTurns(
    Object.values(graph.nodesById),
    workersOf,
  );

  for (const { parentSessionId, key, leaves } of groups) {
    if (leaves.length === 0) continue;
    if (inFlightGroups.has(key)) continue;
    if (leaves.some((node) => isWorkingStatus(node.status))) continue;

    const entries: DigestEntry[] = [];
    const reports: StructuredReport[] = [];
    let ready = true;
    let alreadyPublished = false;
    for (const node of leaves) {
      const report = node.runId ? graph.getReport(node.runId) : undefined;
      if (!report) {
        ready = false;
        break;
      }
      if (report.publishedToParent) alreadyPublished = true;
      entries.push({ node, report });
      reports.push(report);
    }
    if (!ready || alreadyPublished || entries.length === 0) continue;

    const text = buildGroupDigest({ digestId: key, entries });
    if (!text.trim()) continue;

    // Flag first, send second: see the module comment.
    for (const report of reports) {
      graph.attachReport({ ...report, publishedToParent: true });
    }
    inFlightGroups.add(key);
    void (async () => {
      try {
        const result = await deliverEnvelope(parentSessionId, text);
        if (result.status !== "failed") return;
        useChatStore
          .getState()
          .addMessage(
            parentSessionId,
            createSystemNotificationMessage(
              digestDeliveryFailureText(result.detail ?? "", text),
              "error",
            ),
          );
      } finally {
        inFlightGroups.delete(key);
      }
    })();
  }
}

/** Clears the process-local guard. Tests only. */
export function resetDigestPublisherForTests(): void {
  inFlightGroups.clear();
}
