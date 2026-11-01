/**
 * Reading the roadmap a conductor publishes and keeping the newest version.
 *
 * Driven from the wave engine's tick, before plan admission, so a goal turn's
 * answer that carries both a roadmap and a plan is read in the right order:
 * the roadmap first (it may close the goal), the plan after. The pass is
 * idempotent on two levels — the roadmap record remembers the message it came
 * from and its time, and an in-memory set remembers the messages this process
 * already read — so a tick that fires on every streamed token re-reads
 * nothing it has seen.
 */

import { useChatStore } from "@/features/chat/stores/chatStore";
import { isLegacyReplayReplyId } from "@/shared/api/acpReplayMetadata";
import { getTextContent, type Message } from "@/shared/types/messages";

import { BoundedSet } from "./boundedSet";
import { useConductorGraphStore } from "./conductorGraphStore";
import {
  ROADMAP_FENCE_TAG,
  parseFlockRoadmap,
  roadmapProgress,
  type ConductorRoadmap,
} from "./flockRoadmap";
import {
  roadmapInvalidNoticeText,
  roadmapUpdatedNoticeText,
} from "./waveNotices";
import { withRoadmap, type WaveEngineState } from "./waveStore";

/** Messages this process already read for a roadmap fence, or found without one. */
const scanned = new BoundedSet(5_000);

/** The notice a conductor chat gets about one of its roadmap changes. */
export type RoadmapNoticeSink = (
  sessionId: string,
  text: string,
  retryAction: boolean,
  type?: "error" | "warning",
) => unknown;

function isSettledAssistantMessage(message: Message): boolean {
  return (
    message.role === "assistant" &&
    message.metadata?.completionStatus !== "inProgress" &&
    !isLegacyReplayReplyId(message.id)
  );
}

/**
 * Applies a roadmap fence to the conductor's record, keeping the loop's
 * bookkeeping: the continue count and the turn in flight belong to the goal,
 * not to the message that restated it. A roadmap whose goal text changed is a
 * new goal and starts its count over.
 */
export function applyRoadmapMessage(
  current: ConductorRoadmap | undefined,
  conductorSessionId: string,
  message: Pick<Message, "id" | "created">,
  body: Omit<
    ConductorRoadmap,
    | "conductorSessionId"
    | "updatedAt"
    | "sourceMessageId"
    | "sourceCreatedAt"
    | "continueTurns"
    | "continueTurn"
  >,
  now: number,
): ConductorRoadmap {
  const sameGoal = current?.goal.trim() === body.goal.trim();
  return {
    ...body,
    conductorSessionId,
    updatedAt: now,
    sourceMessageId: message.id,
    sourceCreatedAt: message.created,
    continueTurns: sameGoal ? (current?.continueTurns ?? 0) : 0,
    ...(sameGoal && current?.continueTurn
      ? { continueTurn: current.continueTurn }
      : {}),
  };
}

/**
 * Roadmap pass: every settled conductor message newer than the conductor's
 * current roadmap is read once; the newest readable fence becomes the roadmap.
 */
export function processRoadmaps(
  state: WaveEngineState,
  notify: RoadmapNoticeSink,
): WaveEngineState {
  let next = state;
  const chat = useChatStore.getState();
  const graph = useConductorGraphStore.getState();
  for (const node of Object.values(graph.nodesById)) {
    if (node.role !== "conductor") continue;
    const messages = chat.messagesBySession[node.sessionId];
    if (!messages?.length) continue;
    for (const message of messages) {
      if (scanned.has(message.id)) continue;
      if (!isSettledAssistantMessage(message)) continue;
      const current = next.roadmaps[node.sessionId];
      // Older than the roadmap the conductor already has: read before, or
      // superseded by a later block — either way not news.
      if (current && message.created <= current.sourceCreatedAt) {
        scanned.add(message.id);
        continue;
      }
      const text = getTextContent(message);
      if (!text.includes(ROADMAP_FENCE_TAG)) {
        scanned.add(message.id);
        continue;
      }
      const parse = parseFlockRoadmap(text);
      scanned.add(message.id);
      if (parse.kind === "none") continue;
      if (parse.kind === "invalid") {
        notify(
          node.sessionId,
          roadmapInvalidNoticeText(parse.detail),
          false,
          "warning",
        );
        continue;
      }
      const roadmap = applyRoadmapMessage(
        current,
        node.sessionId,
        message,
        parse.roadmap,
        Date.now(),
      );
      next = withRoadmap(next, roadmap);
      const progress = roadmapProgress(roadmap);
      notify(
        node.sessionId,
        roadmapUpdatedNoticeText({
          goal: roadmap.goal,
          done: progress.done,
          total: progress.total,
          status: roadmap.status,
        }),
        false,
        "warning",
      );
    }
  }
  return next;
}

/** Clears the process-local scan marks. Tests only. */
export function resetRoadmapSyncForTests(): void {
  scanned.clear();
}
