import type { Message, MessageContent } from "@/shared/types/messages";

import { WAVE_FENCE_TAG, parseDistillWave } from "./distillWave";

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
    const content = message.content
      .filter(isVisibleConductorBlock)
      .map((block) => stripWavePlanFence(block, wavePlanLabel));
    if (!hasVisibleConductorContent(content)) {
      return [];
    }
    return [{ ...message, content }];
  });
}
