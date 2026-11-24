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

/** A fenced block that Markdown shows as one of the message's own blocks. */
export interface TopLevelFencedBlock {
  /** The run that opened it: "```", "````", "~~~", or "$$" for math. */
  fence: string;
  /** Everything after the run on the opening line, trimmed. */
  info: string;
  /** Offset of the opening line. */
  start: number;
  /** Offset of the first line after the opening one. */
  bodyStart: number;
  /** Offset of the closing line, or the end of the text. */
  bodyEnd: number;
  /** Offset just past the closing run's line, terminator excluded. */
  end: number;
  /** False when the text ended before the block was closed. */
  closed: boolean;
}

/**
 * The fenced blocks that stand at the top level of `text`, read the way the
 * transcript's Markdown reads it.
 *
 * Every protocol block is a request the app acts on — a wave of up to
 * sixty-four sessions, a verdict, a memory written into every later prompt —
 * so what counts as one is what the operator sees as one: a code block of
 * the message itself. The readers used to match the tag line wherever it
 * stood, and the transcript then showed something else: a plan quoted
 * inside a longer fence or a `~~~` fence rendered as one quoted file, a
 * memory request inside an HTML comment rendered as nothing at all, and
 * both were acted on. A tag line inside another fence (or a `$$` math
 * block), inside a blockquote, a list item or an HTML block, or indented
 * into a code block is text here.
 *
 * A line scanner rather than a Markdown parser, because this runs on every
 * settled message and the memory scan runs on every streamed one. Where the
 * scanner cannot tell what Markdown would do without the full grammar — a
 * list that may or may not have ended, a line that may be an HTML tag — it
 * takes the reading that makes fewer blocks top-level. A block it refuses
 * by mistake is a plan the conductor is asked to send again; one it accepts
 * by mistake is a request nobody saw.
 */
export function topLevelFencedBlocks(text: string): TopLevelFencedBlock[] {
  const blocks: TopLevelFencedBlock[] = [];
  let fence: {
    char: string;
    length: number;
    run: string;
    info: string;
    start: number;
    bodyStart: number;
  } | null = null;
  // The end of the HTML block the scan is in: a pattern the closing line
  // contains, or "blank" for the kinds that a blank line ends.
  let html: RegExp | "blank" | null = null;
  // The content column of the list item the scan may be in. The narrowest
  // column the marker allows, so that more lines count as inside the item.
  let listContent: number | null = null;
  let previousBlank = false;

  const lineBreak = /\r\n|\r|\n/g;
  let lineStart = 0;
  for (;;) {
    const match = lineBreak.exec(text);
    const lineEnd = match ? match.index : text.length;
    const nextStart = match ? match.index + match[0].length : text.length;
    const line = text.slice(lineStart, lineEnd);
    const blank = /^[ \t]*$/.test(line);

    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (
        close &&
        close[1][0] === fence.char &&
        close[1].length >= fence.length
      ) {
        blocks.push({
          fence: fence.run,
          info: fence.info,
          start: fence.start,
          bodyStart: fence.bodyStart,
          bodyEnd: lineStart,
          end: lineEnd,
          closed: true,
        });
        fence = null;
        previousBlank = false;
      }
    } else if (html) {
      if (html === "blank" ? blank : html.test(line)) html = null;
      previousBlank = blank;
    } else if (blank) {
      previousBlank = true;
    } else {
      const indent = indentColumns(line);
      let topLevel = true;
      if (listContent !== null && indent >= listContent) {
        topLevel = false;
      } else if (listContent !== null) {
        const marker = listItemContent(line);
        if (marker !== null) {
          listContent = marker;
          topLevel = false;
        } else if (
          !previousBlank &&
          fenceOpening(line) === null &&
          htmlBlockEnd(line, false) === undefined
        ) {
          // A lazy continuation of the item's paragraph, or something that
          // may end the list; kept inside either way.
          topLevel = false;
        } else {
          listContent = null;
        }
      }
      previousBlank = false;
      if (topLevel && indent < 4 && !BLOCKQUOTE.test(line)) {
        const open = fenceOpening(line);
        const htmlEnd = open ? undefined : htmlBlockEnd(line, true);
        if (open) {
          fence = {
            ...open,
            start: lineStart,
            bodyStart: nextStart,
          };
        } else if (htmlEnd !== undefined) {
          html = htmlEnd;
        } else {
          const marker = listItemContent(line);
          if (marker !== null) listContent = marker;
        }
      }
    }

    if (!match) break;
    lineStart = nextStart;
  }
  if (fence) {
    blocks.push({
      fence: fence.run,
      info: fence.info,
      start: fence.start,
      bodyStart: fence.bodyStart,
      bodyEnd: text.length,
      end: text.length,
      closed: false,
    });
  }
  return blocks;
}

/**
 * The top-level blocks of `text` that carry the protocol tag `tag`.
 *
 * `spelling` is how the opening line must name it, and each protocol keeps
 * the one it has always had, so a block a well-behaved agent writes reads
 * exactly as before:
 * - `exact`: three backticks and the tag alone on the line (plan, verdict,
 *   roadmap — the spelling `openingFencePattern` describes);
 * - `info`: the tag as the first word of a backtick or tilde fence of any
 *   length, with no backtick on the line (memory and recall).
 * The tag is matched without regard to case.
 */
export function protocolBlocks(
  text: string,
  tag: string,
  spelling: "exact" | "info",
): TopLevelFencedBlock[] {
  const wanted = tag.toLowerCase();
  return topLevelFencedBlocks(text).filter((block) => {
    if (spelling === "exact") {
      return block.fence === "```" && block.info.toLowerCase() === wanted;
    }
    if (block.fence[0] === "$" || block.info.includes("`")) return false;
    return block.info.split(/[ \t]/)[0].toLowerCase() === wanted;
  });
}

/** A fence run with what follows it; `$$` opens a math block. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,}|\${2,})(.*)$/;
/** A run that closes a fence: nothing but blanks after it. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,}|\${2,})[ \t]*$/;
const BLOCKQUOTE = /^ {0,3}>/;
const LIST_MARKER = /^( {0,3})([-+*]|\d{1,9}[.)])(?=[ \t]|$)/;

function fenceOpening(
  line: string,
): { char: string; length: number; run: string; info: string } | null {
  const match = FENCE_OPEN.exec(line);
  if (!match) return null;
  const run = match[1];
  const char = run[0];
  // A backtick fence's info string cannot hold a backtick, nor a math
  // fence's a dollar: Markdown reads such a line as inline text.
  if (char === "`" && match[2].includes("`")) return null;
  if (char === "$" && match[2].includes("$")) return null;
  return { char, length: run.length, run, info: match[2].trim() };
}

/** Columns of leading blanks, a tab advancing to the next multiple of four. */
function indentColumns(line: string): number {
  let columns = 0;
  for (const char of line) {
    if (char === " ") columns += 1;
    else if (char === "\t") columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

/** The content column of a list item this line opens, or `null`. */
function listItemContent(line: string): number | null {
  const match = LIST_MARKER.exec(line);
  return match ? match[1].length + match[2].length + 1 : null;
}

const HTML_RAW_START = /^ {0,3}<(?:script|pre|style|textarea)(?:[ \t>]|$)/i;
const HTML_BLOCK_NAMES =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const HTML_NAMED_START = new RegExp(
  `^ {0,3}</?(?:${HTML_BLOCK_NAMES})(?:[ \\t>]|/>|$)`,
  "i",
);
/** Any tag alone on its line, read more widely than Markdown does. */
const HTML_ANY_TAG_START = /^ {0,3}<\/?[A-Za-z].*>[ \t]*$/;

/**
 * Where the HTML block this line opens ends: a pattern its last line
 * contains, "blank", or `undefined` when the line opens none. `null` when
 * it opens one that ends on this same line.
 *
 * `anyTag` admits the last kind, a bare tag on its own line, which Markdown
 * does not let interrupt a paragraph: counted as a block wherever it stands
 * when looking for blocks to refuse, and never as one that could end a list.
 */
function htmlBlockEnd(
  line: string,
  anyTag: boolean,
): RegExp | "blank" | null | undefined {
  const until = (end: RegExp) => (end.test(line) ? null : end);
  if (HTML_RAW_START.test(line)) {
    return until(/<\/(?:script|pre|style|textarea)>/i);
  }
  if (/^ {0,3}<!--/.test(line)) return until(/-->/);
  if (/^ {0,3}<\?/.test(line)) return until(/\?>/);
  if (/^ {0,3}<![A-Za-z]/.test(line)) return until(/>/);
  if (/^ {0,3}<!\[CDATA\[/.test(line)) return until(/\]\]>/);
  if (HTML_NAMED_START.test(line)) return "blank";
  if (anyTag && HTML_ANY_TAG_START.test(line)) return "blank";
  return undefined;
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
