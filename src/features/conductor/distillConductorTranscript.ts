import type { Message, MessageContent } from "@/shared/types/messages";

import { turnHasToolCall } from "./conductorSelfExecution";
import { VERDICT_FENCE_TAG, parseDistillVerdict } from "./distillVerdict";
import { WAVE_FENCE_TAG, parseDistillWave } from "./distillWave";
import {
  conductorSelfExecutionBadgeText,
  waveVerdictProseFallback,
} from "./waveNotices";

const VISIBLE_BLOCK_TYPES = new Set<MessageContent["type"]>([
  "text",
  "image",
  "mcpApp",
]);

/**
 * Last-resort stand-in for a plan message whose prose was empty.
 *
 * The only production caller passes a translated `wavePlanLabel`; this constant
 * exists so a future caller that forgets cannot make the chip host disappear.
 */
const FALLBACK_WAVE_PLAN_LABEL = "Plan for the brigade below.";

export interface DistillConductorTranscriptOptions {
  /**
   * Localized one-liner shown in place of a `distill-wave` fence when the
   * conductor sent the plan with no prose around it. Never empty: the plan
   * message is the brigade chips' anchor, so it must survive distillation.
   */
  wavePlanLabel?: string;
}

function isVisibleConductorBlock(block: MessageContent): boolean {
  if (block.type === "systemNotification") {
    return (
      block.notificationType === "error" || block.notificationType === "warning"
    );
  }
  return VISIBLE_BLOCK_TYPES.has(block.type);
}

function hasVisibleConductorContent(
  content: readonly MessageContent[],
): boolean {
  return content.some((block) => {
    if (block.type === "text") {
      return block.text.trim().length > 0;
    }
    return true;
  });
}

/**
 * Replace a machine-facing wave plan with the prose that came with it.
 *
 * Parsing happens per text block, not on the joined message: the fence lives
 * inside exactly one block and the others keep their text and their order.
 *
 * Only a `kind: "plan"` parse is rewritten. An `invalid` parse keeps its raw
 * text so the operator can read the broken block next to the error notice —
 * and that is also what protects a still-streaming message, whose half-written
 * fence parses as `unterminated-fence`.
 */
function stripWavePlanFence(
  block: MessageContent,
  wavePlanLabel: string,
): MessageContent {
  if (block.type !== "text") return block;
  // Cheap reject before the fence scan: this runs over the whole transcript on
  // every render of a conductor chat, i.e. on every streamed token.
  if (!block.text.includes(WAVE_FENCE_TAG)) return block;
  const parse = parseDistillWave(block.text);
  if (parse.kind !== "plan") return block;
  return { ...block, text: parse.prose || wavePlanLabel };
}

/**
 * Replace a machine-facing verdict with the prose that came with it.
 *
 * The verdict fence is the conductor's answer to a digest, and on `accept` the
 * prose around it *is* the operator's answer (D4) — leaving raw protocol JSON
 * next to it would make the answer unreadable. Only a `kind: "verdict"` parse
 * is rewritten, on the same reasoning as the plan fence: an unreadable verdict
 * stays visible beside the notice that explains it, and a half-streamed one
 * parses as invalid and is left alone until it settles.
 *
 * Gated on the message actually containing a verdict fence, so a plain wave
 * plan (which `parseDistillVerdict` also reads, as a bare revision) is left to
 * `stripWavePlanFence` and its own label.
 */
function stripVerdictFence(block: MessageContent): MessageContent {
  if (block.type !== "text") return block;
  if (!block.text.includes(VERDICT_FENCE_TAG)) return block;
  const parse = parseDistillVerdict(block.text);
  if (parse.kind !== "verdict") return block;
  return {
    ...block,
    text: parse.prose || waveVerdictProseFallback(parse.verdict.outcome),
  };
}

/**
 * The Q6 badge: "the conductor is doing the work itself".
 *
 * The conductor is prompt-only — it plans or it answers (D3/Q6) — but it is an
 * ordinary session with an ordinary toolset, so the instruction can leak. The
 * operator decision was to make a leak *visible* rather than to forbid it at
 * the harness, and to revisit only if it happens for real.
 *
 * It has to be minted here rather than in the bubble, because this is the last
 * layer that can see a tool call at all: a conductor transcript is distilled
 * down to text/image/mcpApp blocks, and by the time `MessageBubble` renders the
 * turn its tool calls are gone. Derived from the turn's own content, appended
 * to the turn it belongs to; nothing is stored anywhere.
 */
function selfExecutionBadge(
  content: readonly MessageContent[],
): MessageContent | null {
  return turnHasToolCall(content)
    ? {
        type: "systemNotification",
        notificationType: "warning",
        text: conductorSelfExecutionBadgeText(),
      }
    : null;
}

export function distillConductorTranscript(
  messages: readonly Message[],
  options: DistillConductorTranscriptOptions = {},
): Message[] {
  const wavePlanLabel =
    options.wavePlanLabel?.trim() || FALLBACK_WAVE_PLAN_LABEL;

  return messages.flatMap((message) => {
    if (message.role === "user" || message.role === "system") {
      return [message];
    }

    // Fences are stripped before the emptiness check: a plan-only message is
    // the wave's `anchorMessageId`, so dropping it would strand the brigade
    // chips that hang off it.
    const badge = selfExecutionBadge(message.content);
    const content = message.content
      .filter(isVisibleConductorBlock)
      .map((block) => stripVerdictFence(block))
      .map((block) => stripWavePlanFence(block, wavePlanLabel));
    if (!hasVisibleConductorContent(content) && !badge) {
      return [];
    }
    return [{ ...message, content: badge ? [badge, ...content] : content }];
  });
}
