import {
  GOAL_STATE_FENCE,
  LOOP_STATE_FENCE,
} from "@/features/chat-automation/automationProtocol";

/**
 * The opening fence of a protocol block: up to three leading spaces, the
 * backticks, optional whitespace, the tag, and nothing else on the line.
 *
 * Exported because anything that *removes* protocol blocks has to agree with
 * the parser about what one is, exactly. It did not: the digest's strip
 * required the tag to follow the backticks immediately, so "``` distill-wave"
 * on its own line survived the strip and was still a plan to the scanner — a
 * worker-authored plan the conductor could echo back into a real wave. A
 * shared pattern cannot drift.
 *
 * Fresh each call: the regex is global and carries `lastIndex`.
 */
export function openingFencePattern(tag: string): RegExp {
  return new RegExp(`^[ \\t]{0,3}\`\`\`[ \\t]*${tag}[ \\t]*\\r?$`, "gim");
}

/** The closing fence, on the same terms. Fresh each call. */
export function closingFencePattern(): RegExp {
  return /^[ \t]{0,3}```[ \t]*\r?$/m;
}

/**
 * The protocol tags a report may never smuggle into a digest.
 *
 * `distill-recall` is absent on purpose: its parser is exact-tag and reads only
 * the conductor's own turns, so there is nothing to launder.
 */
const PROTOCOL_FENCE_TAGS = [
  "distill-wave",
  "distill-verdict",
  "distill-report",
  "distill-memory",
  GOAL_STATE_FENCE,
  LOOP_STATE_FENCE,
] as const;

const collapsedOpening = new RegExp(
  `\`\`\`[ \\t]*(?:${PROTOCOL_FENCE_TAGS.join("|")})(?=\\s|$)`,
  "i",
);

const PROTOCOL_BLOCK_REMOVED = "[protocol block removed]";

/**
 * Removes protocol fences from text that is about to be quoted into a digest.
 *
 * A worker's summary is free-form prose and can quote anything, including a
 * `distill-wave` block. Such a block could never *run* — a digest is a user
 * message and the plan detector only ever scans assistant messages — but the
 * conductor reading the digest is a model, and a plan-shaped block inside a
 * report it is asked to judge is an invitation to echo it back. Ordinary code
 * fences are left exactly as they are; only the active protocol tags are cut.
 *
 * `distill-memory` is cut for the sharpest version of that echo: the memory
 * scanner refuses a worker's fence but honors the conductor's, so a memory
 * request smuggled through a report and repeated back by the conductor would
 * be laundered into exactly the write the ACL refused at the source.
 *
 * The cut uses the *parser's own* opening fence (`openingFencePattern`) rather
 * than a second, stricter regex of its own. The two used to disagree about one
 * character: the strip demanded the tag immediately after the backticks, while
 * the scanner allows spaces and tabs, so a report ending in "``` distill-wave"
 * on its own line reached the conductor intact and, echoed back without a
 * verdict fence, was read as a revision — a worker-authored plan spawning real
 * executors. Sharing the pattern makes that class of gap unrepresentable.
 *
 * A protocol fence that is never closed is cut to the end of the text: from
 * the model's point of view everything after the opening line is inside the
 * block, and half a smuggled plan plus the conductor's own closing fence is
 * still a plan.
 */
export function stripProtocolFences(
  text: string,
  mode: "digest" | "preview" = "digest",
): string {
  const preview = mode === "preview";
  if (!text.includes("```")) return preview ? text : text.trim();
  let result = text;
  // A streamed or capped preview may cut the opening tag in half.
  if (preview) {
    const tail = /```[ \t]*([\w-]+)\u2026?$/.exec(result);
    if (
      tail &&
      PROTOCOL_FENCE_TAGS.some((tag) => tag.startsWith(tail[1].toLowerCase()))
    )
      result = result.slice(0, tail.index);
  }
  // One block at a time, rescanning after each cut: a cut moves every offset
  // behind it, and the replacement text contains no fence to re-match.
  for (;;) {
    const block = nextProtocolBlock(result, preview && !text.includes("\n"));
    if (!block) break;
    result = `${result.slice(0, block.start)}${preview ? "" : PROTOCOL_BLOCK_REMOVED}${result.slice(block.end)}`;
  }
  return preview ? result : result.trim();
}

/** The first protocol block in `text`, by the parser's own grammar. */
function nextProtocolBlock(
  text: string,
  collapsed: boolean,
): { start: number; end: number } | null {
  // List snippets have already lost their line boundaries and may end inside the block.
  if (collapsed) {
    const match = collapsedOpening.exec(text);
    if (match) {
      const close = text.indexOf("```", match.index + match[0].length);
      return { start: match.index, end: close < 0 ? text.length : close + 3 };
    }
  }
  let opening: { start: number; end: number } | null = null;
  for (const tag of PROTOCOL_FENCE_TAGS) {
    const match = openingFencePattern(tag).exec(text);
    if (!match) continue;
    if (!opening || match.index < opening.start) {
      opening = { start: match.index, end: match.index + match[0].length };
    }
  }
  if (!opening) return null;
  const rest = text.slice(opening.end);
  const closing = closingFencePattern().exec(rest);
  return {
    start: opening.start,
    end: closing
      ? opening.end + closing.index + closing[0].length
      : text.length,
  };
}
