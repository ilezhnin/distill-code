import { isTextContent, type Message, type MessageContent } from "./messages";

/**
 * One piece of a message an edit or a removal names, the same on the renderer
 * and on the host: the n-th run of adjacent text blocks, the n-th run of
 * adjacent reasoning blocks, or a tool call by its id. Runs are counted over
 * the blocks the user sees, so a block addressed to the agent alone is
 * transparent — as is, on the host, a tool call's progress record.
 */
export type MessagePart =
  | { kind: "text"; ordinal: number }
  | { kind: "reasoning"; ordinal: number }
  | { kind: "tool"; toolCallId: string };

export interface MessagePartSpan {
  part: MessagePart;
  /** The blocks the part is made of, as indexes into the array it was computed over. */
  indexes: number[];
}

export function isReasoningBlock(block: MessageContent): boolean {
  return (
    block.type === "thinking" ||
    block.type === "reasoning" ||
    block.type === "redactedThinking"
  );
}

export function isToolBlock(block: MessageContent): boolean {
  return block.type === "toolRequest" || block.type === "toolResponse";
}

/**
 * Whether the transcript shows a block to the user: one with no audience, or
 * one addressed to the user among others (the rule the projection's
 * `getUserVisibleMessageContent` applies).
 */
export function isShownToUser(block: MessageContent): boolean {
  const audience =
    "annotations" in block ? block.annotations?.audience : undefined;
  return !audience || audience.length === 0 || audience.includes("user");
}

export function sameMessagePart(
  left: MessagePart,
  right: MessagePart,
): boolean {
  if (left.kind === "tool" || right.kind === "tool") {
    return (
      left.kind === "tool" &&
      right.kind === "tool" &&
      left.toolCallId === right.toolCallId
    );
  }
  return left.kind === right.kind && left.ordinal === right.ordinal;
}

/**
 * The parts of `blocks`, in order, with indexes into `blocks`. A text or
 * reasoning run ends at any block of another kind; a tool call's request and
 * response make one part wherever they sit.
 */
export function messagePartSpans(
  blocks: readonly MessageContent[],
): MessagePartSpan[] {
  const spans: MessagePartSpan[] = [];
  const toolSpans = new Map<string, MessagePartSpan>();
  let textOrdinal = 0;
  let reasoningOrdinal = 0;
  let run: MessagePartSpan | null = null;
  blocks.forEach((block, index) => {
    const kind = isTextContent(block)
      ? "text"
      : isReasoningBlock(block)
        ? "reasoning"
        : null;
    if (kind) {
      if (run?.part.kind === kind) {
        run.indexes.push(index);
        return;
      }
      run = {
        part:
          kind === "text"
            ? { kind, ordinal: textOrdinal++ }
            : { kind, ordinal: reasoningOrdinal++ },
        indexes: [index],
      };
      spans.push(run);
      return;
    }
    run = null;
    if (block.type === "toolRequest" || block.type === "toolResponse") {
      let span = toolSpans.get(block.id);
      if (!span) {
        span = { part: { kind: "tool", toolCallId: block.id }, indexes: [] };
        toolSpans.set(block.id, span);
        spans.push(span);
      }
      span.indexes.push(index);
    }
  });
  return spans;
}

/**
 * The parts of `message` over the blocks the user sees, with indexes into
 * `message.content`.
 */
export function visibleMessagePartSpans(message: Message): MessagePartSpan[] {
  const visible = message.content.flatMap((block, index) =>
    isShownToUser(block) ? [{ block, index }] : [],
  );
  return messagePartSpans(visible.map(({ block }) => block)).map((span) => ({
    part: span.part,
    indexes: span.indexes.map((index) => visible[index]?.index as number),
  }));
}

export function findMessagePartSpan(
  message: Message,
  part: MessagePart,
): MessagePartSpan | undefined {
  return visibleMessagePartSpans(message).find((span) =>
    sameMessagePart(span.part, part),
  );
}
