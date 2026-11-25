/**
 * Finding the conductor messages that carry a wave plan.
 *
 * Pure: it reads transcripts and a "have I seen this message id" predicate and
 * returns candidates. Deciding what to do with a candidate is `waveEngine.ts`;
 * actually doing it is `waveRunner.ts`.
 */

import { isLegacyReplayReplyId } from "@/shared/api/acpReplayMetadata";
import {
  type UnreadProtocolBlockReason,
  unreadProtocolBlocks,
} from "@/shared/lib/protocolFences";
import {
  getTextContent,
  isMessageKnownAs,
  type Message,
} from "@/shared/types/messages";

import {
  WAVE_FENCE_TAG,
  parseFlockWave,
  type WaveInvalid,
  type WavePlan,
} from "./flockWave";

const MENTIONS_WAVE_TAG = new RegExp(WAVE_FENCE_TAG, "i");

export interface WavePlanCandidate {
  conductorSessionId: string;
  /** Assistant message that carried the fence. The wave's dedup key. */
  planMessageId: string;
  /** When that message was created. The engine's watermark is set from it. */
  createdAt: number;
  parse: WavePlan | WaveInvalid;
}

/**
 * A message is a candidate only once it has stopped streaming: a half-written
 * fence parses as `unterminated-fence`, and rejecting a plan the model is still
 * typing would be a false error every single time.
 */
function isSettledAssistantMessage(message: Message): boolean {
  return (
    message.role === "assistant" &&
    message.metadata?.completionStatus !== "inProgress" &&
    // A reply replayed under a derived id was handled when it streamed, under
    // an id no reload reproduces; its tombstone cannot match it.
    !isLegacyReplayReplyId(message.id)
  );
}

/**
 * Scans the given conductor transcripts for unprocessed `distill-wave` fences.
 *
 * `isProcessed` is the persisted tombstone: a plan message that has ever been
 * admitted *or* rejected is never a candidate again, which is what keeps a
 * broken fence from re-erroring on every store change. It is asked before the
 * text is even joined, and it is given the message's conductor and `created`
 * time so the caller can also answer "this one is behind my watermark" without
 * a second pass over the transcript. A message is asked about under every id
 * it has gone by (`isMessageKnownAs`): a plan admitted while replies were
 * still named by their agent has its tombstone under that name.
 */
export function detectWavePlanCandidates(args: {
  conductorSessionIds: readonly string[];
  messagesBySession: Readonly<Record<string, readonly Message[] | undefined>>;
  isProcessed: (
    planMessageId: string,
    context: { conductorSessionId: string; createdAt: number },
  ) => boolean;
  /**
   * Called once for every settled message that turned out to carry no plan.
   * The runner remembers those ids so the next tick — and the sync subscription
   * fires on every chat-store change, i.e. on every streamed token — can skip
   * them without re-joining their text. The context is for telemetry: a
   * planless conductor turn is the wave-rate denominator, and its `created`
   * time is what deduplicates the count across restarts.
   */
  markScanned?: (
    messageId: string,
    context: { conductorSessionId: string; createdAt: number },
  ) => void;
  /**
   * Called for a settled message that carries no plan the reader takes but
   * does hold a plan's opening line: inside a quote, a list, another code
   * block. Such a reply used to be marked scanned in silence, and a
   * conductor that meant the plan waited for a wave that never started.
   */
  onUnreadPlan?: (
    messageId: string,
    context: { conductorSessionId: string; createdAt: number },
    reason: UnreadProtocolBlockReason,
  ) => void;
}): WavePlanCandidate[] {
  const candidates: WavePlanCandidate[] = [];
  for (const conductorSessionId of args.conductorSessionIds) {
    const messages = args.messagesBySession[conductorSessionId];
    if (!messages?.length) continue;
    for (const message of messages) {
      if (!isSettledAssistantMessage(message)) continue;
      const context = { conductorSessionId, createdAt: message.created };
      if (isMessageKnownAs(message, (id) => args.isProcessed(id, context)))
        continue;
      const text = getTextContent(message);
      // Cheap reject before the real parse: most conductor turns are prose.
      // Without regard to case, as the reader matches the tag.
      if (!MENTIONS_WAVE_TAG.test(text)) {
        args.markScanned?.(message.id, {
          conductorSessionId,
          createdAt: message.created,
        });
        continue;
      }
      const parse = parseFlockWave(text);
      if (parse.kind === "none") {
        const unread = args.onUnreadPlan
          ? unreadProtocolBlocks(text, WAVE_FENCE_TAG)[0]
          : undefined;
        if (unread) args.onUnreadPlan?.(message.id, context, unread.reason);
        args.markScanned?.(message.id, {
          conductorSessionId,
          createdAt: message.created,
        });
        continue;
      }
      candidates.push({
        conductorSessionId,
        planMessageId: message.id,
        createdAt: message.created,
        parse,
      });
    }
  }
  return candidates;
}
