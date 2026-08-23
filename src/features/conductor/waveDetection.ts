/**
 * Finding the conductor messages that carry a wave plan.
 *
 * Pure: it reads transcripts and a "have I seen this message id" predicate and
 * returns candidates. Deciding what to do with a candidate is `waveEngine.ts`;
 * actually doing it is `waveRunner.ts`.
 */

import { getTextContent, type Message } from "@/shared/types/messages";

import {
  WAVE_FENCE_TAG,
  parseDistillWave,
  type WaveInvalid,
  type WavePlan,
} from "./distillWave";

export interface WavePlanCandidate {
  conductorSessionId: string;
  /** Assistant message that carried the fence. The wave's dedup key. */
  planMessageId: string;
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
    message.metadata?.completionStatus !== "inProgress"
  );
}

/**
 * Scans the given conductor transcripts for unprocessed `distill-wave` fences.
 *
 * `isProcessed` is the persisted tombstone: a plan message that has ever been
 * admitted *or* rejected is never a candidate again, which is what keeps a
 * broken fence from re-erroring on every store change.
 */
export function detectWavePlanCandidates(args: {
  conductorSessionIds: readonly string[];
  messagesBySession: Readonly<Record<string, readonly Message[] | undefined>>;
  isProcessed: (planMessageId: string) => boolean;
  /**
   * Called once for every settled message that turned out to carry no plan.
   * The runner remembers those ids so the next tick — and the sync subscription
   * fires on every chat-store change, i.e. on every streamed token — can skip
   * them without re-joining their text.
   */
  markScanned?: (messageId: string) => void;
}): WavePlanCandidate[] {
  const candidates: WavePlanCandidate[] = [];
  for (const conductorSessionId of args.conductorSessionIds) {
    const messages = args.messagesBySession[conductorSessionId];
    if (!messages?.length) continue;
    for (const message of messages) {
      if (!isSettledAssistantMessage(message)) continue;
      if (args.isProcessed(message.id)) continue;
      const text = getTextContent(message);
      // Cheap reject before the real parse: most conductor turns are prose.
      if (!text.includes(WAVE_FENCE_TAG)) {
        args.markScanned?.(message.id);
        continue;
      }
      const parse = parseDistillWave(text);
      if (parse.kind === "none") {
        args.markScanned?.(message.id);
        continue;
      }
      candidates.push({
        conductorSessionId,
        planMessageId: message.id,
        parse,
      });
    }
  }
  return candidates;
}
