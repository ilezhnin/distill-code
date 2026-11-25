import {
  GOAL_STATE_FENCE,
  LOOP_STATE_FENCE,
} from "@/features/chat-automation/automationProtocol";

/** A fenced code block that Markdown shows as one of the message's own blocks. */
export interface TopLevelFencedBlock {
  /** The run that opened it: "```", "````", "~~~" and so on. */
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
 * Why a protocol block's opening line is not a block the app reads.
 *
 * - `quote`, `list`, `footnote`: the block stands inside a quotation, a list
 *   item or a footnote, and the transcript shows it there;
 * - `code`: the line is text inside another code block, fenced or indented;
 * - `math`: the line is inside a `$$` math block;
 * - `html`: the line is inside an HTML block or comment;
 * - `text`: the line is ordinary text, as a block written on one line is;
 * - `unclosed`: a block of its own that the reply never closed.
 */
export type UnreadProtocolBlockReason =
  | "quote"
  | "list"
  | "footnote"
  | "code"
  | "math"
  | "html"
  | "text"
  | "unclosed";

/** A protocol block's opening line the reader did not take, and why. */
export interface UnreadProtocolBlock {
  /** The tag as the protocol spells it. */
  tag: string;
  reason: UnreadProtocolBlockReason;
  /** Offset of the opening line. */
  start: number;
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
 * block), inside a blockquote, a list item, a footnote or an HTML block, or
 * indented into a code block is text here.
 *
 * The transcript renders a settled reply with Streamdown, which parses it
 * with remark (micromark, GFM and math). That parser is not a dependency the
 * app can import, and costs about ninety times this scan on a long reply,
 * so this is CommonMark's own block algorithm (the one its reference
 * implementation runs) for the constructs that decide where a block stands:
 * quotations, list items, GFM footnotes and tables, fenced, indented and
 * `$$` blocks, the seven kinds of HTML block, paragraphs and their lazy
 * lines, with micromark's own readings where it differs. Inline content
 * never moves a block, so it is not read. The transcript's parser checks
 * this one in `protocolFences.transcript.test.ts`: on a corpus of the
 * replies agents write and on random ones, the two find the same top-level
 * blocks.
 *
 * It errs in neither direction. A block refused by mistake is a request the
 * operator saw and the app dropped; one accepted by mistake is a request
 * nobody saw. A block the transcript shows inside a quote, a list or another
 * block is not read, and what is said about it is up to its consumer: a
 * plan, a roadmap, a memory request or a recall question gets a notice in
 * its chat (`unreadProtocolBlocks`), and the conductor is asked once to send
 * such a plan again; a verdict is a missing verdict, which the operator is
 * offered to ask for again; a report is a missing report, which the worker
 * is asked once to send. Only a goal or loop state goes unsaid: that turn
 * ends as a turn without a state does.
 */
export function topLevelFencedBlocks(text: string): TopLevelFencedBlock[] {
  return scanBlocks(text)
    .fences.filter((fence) => fence.containers.length === 0)
    .map(({ containers: _containers, ...block }) => block);
}

/**
 * The top-level blocks of `text` that carry the protocol tag `tag`.
 *
 * A block carries the tag when its language — the first word after the
 * opening run, which is also what picks the card the transcript draws for
 * it — is the tag, in any case. Any fence Markdown accepts opens one:
 * three or more backticks, or three or more tildes. The plan, verdict and
 * roadmap used to demand three backticks and the tag alone, so a
 * `~~~distill-wave` block, or one with a word after the tag, was drawn as a
 * plan and never run.
 */
export function protocolBlocks(
  text: string,
  tag: string,
): TopLevelFencedBlock[] {
  const wanted = tag.toLowerCase();
  return topLevelFencedBlocks(text).filter(
    (block) => languageOf(block.info) === wanted,
  );
}

/**
 * The opening lines of `tag` blocks in `text` that the reader did not take
 * as a closed block of the message's own, with the reason.
 *
 * What the operator is told when a reply holds a protocol block the app did
 * not act on: a plan quoted inside a document the conductor pasted, a memory
 * request in a list item. Markdown, not the app, decided the block is not
 * one of the reply's own; saying so is what keeps a reader that is right
 * from looking like an app that ignores its agents. A line counts when the
 * fence run and the tag open it, after whatever quote marks, list markers
 * and indentation the line sits behind.
 */
export function unreadProtocolBlocks(
  text: string,
  tag: string,
): UnreadProtocolBlock[] {
  if (!text.toLowerCase().includes(tag.toLowerCase())) return [];
  return unreadOpenings(scanBlocks(text), text, [tag.toLowerCase()]).map(
    (opening) => ({ tag, reason: opening.reason, start: opening.start }),
  );
}

/**
 * Where an unread block stands, in words for an agent or a terminal: the
 * conductor's request to send a plan again and `flockctl wave validate`
 * both say it. The operator's notice has its own, translated copy.
 */
export function unreadProtocolBlockPlace(
  reason: UnreadProtocolBlockReason,
): string {
  switch (reason) {
    case "quote":
      return "inside a quote";
    case "list":
      return "inside a list item";
    case "footnote":
      return "inside a footnote";
    case "code":
      return "inside another code block";
    case "math":
      return "inside a math block";
    case "html":
      return "inside an HTML block or comment";
    case "text":
      return "written as text, not as a block on lines of its own";
    case "unclosed":
      return "never closed";
  }
}

/** The language of a fenced block: the first word of its info string. */
function languageOf(info: string): string {
  const word = info.split(/[ \t]/, 1)[0] ?? "";
  // A backslash before punctuation is an escape Markdown removes.
  return word.replace(/\\([!-/:-@[-`{-~])/g, "$1").toLowerCase();
}

// ---- the block scan ---------------------------------------------------------

type ContainerKind = "quote" | "list" | "footnote";

/** A fenced code block at any depth, with the containers it opened in. */
interface ScannedFence extends TopLevelFencedBlock {
  containers: ContainerKind[];
}

type LineRole =
  | "blank"
  | "fence"
  | "fenceContent"
  | "math"
  | "html"
  | "indented"
  | "paragraph"
  | "table"
  | "other";

/** Where one line of the text landed. */
interface ScannedLine {
  start: number;
  /** Where the line's own content begins, past its container marks. */
  content: number;
  end: number;
  role: LineRole;
  containers: ContainerKind[];
  /** The fence this line opened, for a `fence` line. */
  fence?: ScannedFence;
}

interface ScanResult {
  fences: ScannedFence[];
  lines: ScannedLine[];
}

interface OpenContainer {
  kind: ContainerKind;
  /** Columns a continuation line must be indented by (item, footnote). */
  indent: number;
  /** Whether a block was put in it yet: an empty item ends at a blank line. */
  filled: boolean;
}

type OpenLeaf =
  | {
      kind: "paragraph";
      /** The last line's content and indentation: a table's header row. */
      lastLine: string;
      lastIndent: number;
      /** Every line so far is a link reference definition. */
      onlyDefinitions: boolean;
    }
  | { kind: "table" }
  | { kind: "fence"; char: string; length: number; offset: number }
  | { kind: "math"; length: number; offset: number }
  | { kind: "indented"; oneLine: boolean }
  | { kind: "html"; end: RegExp | null };

const HTML_RAW_NAMES = "pre|script|style|textarea";
const HTML_BLOCK_NAMES =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const TAG_NAME = "[A-Za-z][A-Za-z0-9-]*";
const ATTRIBUTE =
  "(?:[ \\t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \\t]*=[ \\t]*(?:[^\"'=<>`\\x00-\\x20]+|'[^']*'|\"[^\"]*\"))?)";
/** The HTML block kinds 1 to 6 by their opening, with the line that ends each. */
const HTML_STARTS: ReadonlyArray<{ open: RegExp; end: RegExp | null }> = [
  {
    open: new RegExp(`^<(?:${HTML_RAW_NAMES})(?:[ \\t>]|$)`, "i"),
    end: new RegExp(`</(?:${HTML_RAW_NAMES})>`, "i"),
  },
  { open: /^<!--/, end: /-->/ },
  { open: /^<\?/, end: /\?>/ },
  { open: /^<![A-Za-z]/, end: />/ },
  { open: /^<!\[CDATA\[/, end: /\]\]>/ },
  {
    open: new RegExp(`^</?(?:${HTML_BLOCK_NAMES})(?:[ \\t>]|/>|$)`, "i"),
    end: null,
  },
];
/**
 * Kind 7: one complete tag alone on its line. It cannot interrupt text. A
 * raw name (`pre`, `script`...) followed by a blank or `>` is kind 1, matched
 * first; any other spelling of it, a closing tag included, is this kind for
 * micromark.
 */
const HTML_LONE_TAG = new RegExp(
  `^(?:<${TAG_NAME}${ATTRIBUTE}*[ \\t]*/?>|</${TAG_NAME}[ \\t]*>)[ \\t]*$`,
  "i",
);
const CODE_FENCE = /^(?:`{3,}(?!.*`)|~{3,})/;
const CLOSING_FENCE = /^(?:`{3,}|~{3,})(?=[ \t]*$)/;
const MATH_FENCE = /^\${2,}(?![^$]*\$)/;
const CLOSING_MATH = /^\${2,}(?=[ \t]*$)/;
const ATX_HEADING = /^#{1,6}(?:[ \t]+|$)/;
const SETEXT_UNDERLINE = /^(?:=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/;
const BULLET = /^[*+-]/;
const ORDERED = /^(\d{1,9})[.)]/;
const FOOTNOTE = /^\[\^(?:[^\]\\\s]|\\.)+\]:/;
/**
 * A link reference definition on one line. A paragraph made only of them is
 * no text a setext underline could turn into a heading.
 */
const LINK_DEFINITION =
  /^\[(?:[^[\]\\]|\\.)*[^[\]\\\s](?:[^[\]\\]|\\.)*\]:[ \t]*(?:<[^<>]*>|[^\s<][^\s]*)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^()]*\)))?[ \t]*$/;
const TABLE_DELIMITER =
  /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** Cells of a table row: split at unescaped pipes, outer pipes dropped. */
function tableCells(row: string): number {
  const cells = row.trim().split(/(?<!\\)\|/);
  if (cells.length > 1 && cells[0].trim() === "") cells.shift();
  if (cells.length > 1 && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.length;
}

/**
 * CommonMark's block phase over `text`: every line placed in the container
 * and the block it belongs to, every fenced block found at its depth.
 */
function scanBlocks(text: string): ScanResult {
  const fences: ScannedFence[] = [];
  const lines: ScannedLine[] = [];
  const containers: OpenContainer[] = [];
  let leaf: OpenLeaf | null = null;
  let openFence: ScannedFence | null = null;

  // The cursor over the current line, in characters and in columns; a tab
  // only partly spent on indentation leaves the rest as spaces.
  let line = "";
  let pos = 0;
  let col = 0;
  let partialTab = false;
  let nextNonspace = 0;
  let nextNonspaceCol = 0;
  let indent = 0;
  let blank = false;

  const findNextNonspace = () => {
    let index = pos;
    let columns = col;
    while (index < line.length) {
      const char = line[index];
      if (char === " ") columns += 1;
      else if (char === "\t") columns += 4 - (columns % 4);
      else break;
      index += 1;
    }
    blank = index >= line.length;
    nextNonspace = index;
    nextNonspaceCol = columns;
    indent = nextNonspaceCol - col;
  };
  const advanceNextNonspace = () => {
    pos = nextNonspace;
    col = nextNonspaceCol;
    partialTab = false;
  };
  const advance = (count: number, columns: boolean) => {
    let left = count;
    while (left > 0 && pos < line.length) {
      if (line[pos] === "\t") {
        const toTab = 4 - (col % 4);
        if (columns) {
          partialTab = toTab > left;
          const step = toTab > left ? left : toTab;
          col += step;
          if (!partialTab) pos += 1;
          left -= step;
        } else {
          partialTab = false;
          col += toTab;
          pos += 1;
          left -= 1;
        }
      } else {
        partialTab = false;
        pos += 1;
        col += 1;
        left -= 1;
      }
    }
  };
  const spaceOrTab = (index: number) =>
    line[index] === " " || line[index] === "\t";

  const closeFence = (bodyEnd: number, end: number, closed: boolean) => {
    if (openFence) {
      openFence.bodyEnd = bodyEnd;
      openFence.end = end;
      openFence.closed = closed;
    }
    openFence = null;
  };
  // A block ends where the text before it ends: an unclosed fence runs to
  // the last line its container kept.
  let lastKeptEnd = 0;
  const closeLeaf = () => {
    if (leaf?.kind === "fence") closeFence(lastKeptEnd, lastKeptEnd, false);
    leaf = null;
  };
  const closeContainersFrom = (depth: number) => {
    if (depth < containers.length) {
      closeLeaf();
      containers.length = depth;
    }
  };
  const markFilled = () => {
    const parent = containers[containers.length - 1];
    if (parent) parent.filled = true;
  };

  const lineBreak = /\r\n|\r|\n/g;
  let lineStart = 0;
  for (;;) {
    const match = lineBreak.exec(text);
    const lineEnd = match ? match.index : text.length;
    const nextStart = match ? match.index + match[0].length : text.length;
    line = text.slice(lineStart, lineEnd);
    pos = 0;
    col = 0;
    partialTab = false;

    const record = (role: LineRole, fence?: ScannedFence) => {
      lines.push({
        start: lineStart,
        content: lineStart + pos,
        end: lineEnd,
        role,
        containers: containers.map((container) => container.kind),
        ...(fence ? { fence } : {}),
      });
      if (role !== "blank") lastKeptEnd = lineEnd;
    };

    // 1. Which open containers this line continues.
    let matched = 0;
    // Whether the last container continued was a footnote that took its
    // four columns: micromark lets a footnote nested right inside it
    // continue on those same columns.
    let footnoteIndentJustTaken = false;
    for (const container of containers) {
      findNextNonspace();
      if (container.kind === "quote") {
        if (indent > 3 || line[nextNonspace] !== ">") break;
        advanceNextNonspace();
        advance(1, false);
        if (spaceOrTab(pos)) advance(1, true);
        footnoteIndentJustTaken = false;
      } else if (blank) {
        if (!container.filled) break;
        advanceNextNonspace();
        footnoteIndentJustTaken = false;
      } else if (indent >= container.indent) {
        advance(container.indent, true);
        footnoteIndentJustTaken = container.kind === "footnote";
      } else if (
        !(
          container.kind === "footnote" &&
          footnoteIndentJustTaken &&
          indent === 0
        )
      ) {
        break;
      }
      matched += 1;
    }
    const containersMatched = matched === containers.length;

    // 2. Whether the open leaf takes the line as it is.
    findNextNonspace();
    let leafMatched = false;
    if (containersMatched && leaf) {
      const open: OpenLeaf = leaf;
      if (open.kind === "fence" || open.kind === "math") {
        const closing =
          indent <= 3 &&
          (open.kind === "fence"
            ? CLOSING_FENCE.exec(line.slice(nextNonspace))
            : CLOSING_MATH.exec(line.slice(nextNonspace)));
        if (
          closing &&
          closing[0][0] === (open.kind === "fence" ? open.char : "$") &&
          closing[0].length >= open.length
        ) {
          if (open.kind === "fence") closeFence(lineStart, lineEnd, true);
          leaf = null;
          record(open.kind === "fence" ? "fenceContent" : "math");
        } else {
          let left = open.offset;
          while (left > 0 && spaceOrTab(pos)) {
            advance(1, true);
            left -= 1;
          }
          record(open.kind === "fence" ? "fenceContent" : "math");
        }
        lineStart = nextStart;
        if (!match) break;
        continue;
      }
      if (open.kind === "indented") {
        if (indent >= 4 || blank) {
          if (blank) advanceNextNonspace();
          else advance(4, true);
          record(blank ? "blank" : "indented");
          lineStart = nextStart;
          if (!match) break;
          continue;
        }
      } else if (open.kind === "html") {
        if (!(blank && open.end === null)) {
          if (open.end?.test(line.slice(pos))) leaf = null;
          record("html");
          lineStart = nextStart;
          if (!match) break;
          continue;
        }
      } else if (!blank) {
        leafMatched = true;
      }
    }
    // Everything this line continued, the open leaf included.
    const allMatched = containersMatched && (leaf === null || leafMatched);
    let tipIsParagraph = (leaf as OpenLeaf | null)?.kind === "paragraph";
    // micromark decides once per line whether a new list item would
    // interrupt something: when the line continued every container and a
    // paragraph or an indented code block is still open, for every item the
    // line starts, nested ones included. Such an item may not be empty, and
    // an ordered one must be numbered exactly 1.
    const interruptsItems =
      containersMatched &&
      ((leaf as OpenLeaf | null)?.kind === "paragraph" ||
        (leaf as OpenLeaf | null)?.kind === "indented");

    // 3. Blocks this line starts, outermost first.
    let opened: OpenLeaf | null = null;
    let containerIsParagraph = leafMatched && leaf?.kind === "paragraph";
    let lazyCandidate = !allMatched && !blank && tipIsParagraph;
    let roleOfLine: LineRole | null = null;
    let lineIndent = 0;
    let openedFence: ScannedFence | undefined;
    let openedContainer = false;
    // A block this line starts closes the containers it did not continue,
    // and whatever leaf was open: a leaf cannot hold another block.
    const startBlock = () => {
      closeContainersFrom(matched);
      closeLeaf();
      leafMatched = false;
      containerIsParagraph = false;
      lazyCandidate = false;
      tipIsParagraph = false;
      markFilled();
    };
    // A lazy line counts like any other: it may be a table's header row.
    const addParagraphLine = (
      paragraph: Extract<OpenLeaf, { kind: "paragraph" }>,
    ) => {
      paragraph.lastLine = line.slice(pos);
      paragraph.lastIndent = lineIndent;
      paragraph.onlyDefinitions &&= LINK_DEFINITION.test(paragraph.lastLine);
    };
    const openContainer = (container: OpenContainer) => {
      containers.push(container);
      matched = containers.length;
      openedContainer = true;
    };
    for (;;) {
      findNextNonspace();
      lineIndent = indent;
      const rest = line.slice(nextNonspace);
      const first = rest[0];
      if (
        indent < 4 &&
        first !== undefined &&
        !/[#`~*+_=<>0-9$[|:-]/.test(first)
      ) {
        advanceNextNonspace();
        break;
      }
      if (indent < 4 && first === ">") {
        advanceNextNonspace();
        advance(1, false);
        if (spaceOrTab(pos)) advance(1, true);
        startBlock();
        openContainer({ kind: "quote", indent: 0, filled: false });
        continue;
      }
      if (indent < 4 && ATX_HEADING.test(rest)) {
        startBlock();
        roleOfLine = "other";
        break;
      }
      const fence = indent < 4 ? CODE_FENCE.exec(rest) : null;
      if (fence) {
        const fenceIndent = indent;
        startBlock();
        advanceNextNonspace();
        advance(fence[0].length, false);
        const info = line.slice(pos).replace(/^[ \t]+|[ \t]+$/g, "");
        openedFence = {
          fence: fence[0],
          info,
          start: lineStart,
          bodyStart: nextStart,
          bodyEnd: text.length,
          end: text.length,
          closed: false,
          containers: containers.map((container) => container.kind),
        };
        fences.push(openedFence);
        openFence = openedFence;
        opened = {
          kind: "fence",
          char: fence[0][0],
          length: fence[0].length,
          offset: fenceIndent,
        };
        roleOfLine = "fence";
        break;
      }
      const mathFence = indent < 4 ? MATH_FENCE.exec(rest) : null;
      if (mathFence) {
        const fenceIndent = indent;
        startBlock();
        opened = {
          kind: "math",
          length: mathFence[0].length,
          offset: fenceIndent,
        };
        roleOfLine = "math";
        break;
      }
      if (indent < 4 && first === "<") {
        const kind = HTML_STARTS.find((start) => start.open.test(rest));
        const loneTag =
          !kind && !containerIsParagraph && HTML_LONE_TAG.test(rest);
        if (loneTag && lazyCandidate) {
          // micromark, unlike CommonMark's reference parser, lets a lone tag
          // end a paragraph on a lazy line, and the HTML block it opens
          // stays inside the containers the line did not continue:
          // `> a` then `<span>` is a quotation holding the tag. Only a line
          // that continues those containers continues the block.
          closeLeaf();
          lazyCandidate = false;
          tipIsParagraph = false;
          matched = containers.length;
          markFilled();
          opened = { kind: "html", end: null };
          roleOfLine = "html";
          break;
        }
        if (kind || loneTag) {
          startBlock();
          opened = { kind: "html", end: kind ? kind.end : null };
          roleOfLine = "html";
          break;
        }
      }
      if (
        indent < 4 &&
        containerIsParagraph &&
        leaf?.kind === "paragraph" &&
        !leaf.onlyDefinitions &&
        SETEXT_UNDERLINE.test(rest)
      ) {
        startBlock();
        roleOfLine = "other";
        break;
      }
      if (indent < 4 && THEMATIC_BREAK.test(rest)) {
        startBlock();
        roleOfLine = "other";
        break;
      }
      const item = indent < 4 ? listMarker(rest) : null;
      if (item) {
        const markerOffset = indent;
        const afterMarker = rest.slice(item.length);
        const emptyItem = /^[ \t]*$/.test(afterMarker);
        if (
          (afterMarker === "" || spaceOrTab(nextNonspace + item.length)) &&
          !(interruptsItems && (emptyItem || !item.mayInterrupt))
        ) {
          startBlock();
          advanceNextNonspace();
          advance(item.length, true);
          const spacesStartCol = col;
          const spacesStartPos = pos;
          do {
            advance(1, true);
          } while (col - spacesStartCol < 5 && spaceOrTab(pos));
          const blankItem = pos >= line.length;
          const spaces = col - spacesStartCol;
          let padding: number;
          if (spaces >= 5 || spaces < 1 || blankItem) {
            padding = item.length + 1;
            col = spacesStartCol;
            pos = spacesStartPos;
            partialTab = false;
            if (spaceOrTab(pos)) advance(1, true);
          } else {
            padding = item.length + spaces;
          }
          openContainer({
            kind: "list",
            indent: markerOffset + padding,
            filled: false,
          });
          continue;
        }
      }
      if (indent < 4 && FOOTNOTE.test(rest)) {
        const label = FOOTNOTE.exec(rest)?.[0] ?? "";
        startBlock();
        advanceNextNonspace();
        advance(label.length, false);
        openContainer({ kind: "footnote", indent: 4, filled: false });
        continue;
      }
      if (
        indent < 4 &&
        containerIsParagraph &&
        leaf?.kind === "paragraph" &&
        leaf.lastIndent < 4 &&
        TABLE_DELIMITER.test(rest) &&
        // Dashes alone are an underline or a rule, never a delimiter row.
        /[|:]/.test(rest) &&
        tableCells(rest) === tableCells(leaf.lastLine)
      ) {
        // The paragraph's last line is the header row. A table that would
        // interrupt the paragraph ends it before that line, which micromark
        // then reads afresh: a lone tag there opens an HTML block (which no
        // longer interrupts anything), and this line is its text.
        if (HTML_LONE_TAG.test(leaf.lastLine)) {
          leaf = { kind: "html", end: null };
          roleOfLine = "html";
        } else {
          leaf = { kind: "table" };
          roleOfLine = "table";
        }
        advanceNextNonspace();
        break;
      }
      // Indented code cannot interrupt a paragraph; it can end a table.
      if (indent >= 4 && !tipIsParagraph && !blank) {
        // On a lazy line — one that continued not every container and
        // opened none — micromark ends the code block with that line.
        const oneLine = !containersMatched && !openedContainer;
        startBlock();
        advance(4, true);
        opened = { kind: "indented", oneLine };
        roleOfLine = "indented";
        break;
      }
      advanceNextNonspace();
      break;
    }

    // 4. Where the rest of the line goes.
    if (roleOfLine === "table" || (roleOfLine === "html" && !opened)) {
      // A delimiter row: the paragraph became a table, or an HTML block.
      record(roleOfLine);
    } else if (opened) {
      leaf = opened;
      if (opened.kind === "html") {
        // Kinds 1 to 5 may end on the line that opened them.
        if (opened.end?.test(line.slice(pos))) leaf = null;
      }
      record(roleOfLine ?? "other", openedFence);
    } else if (roleOfLine === "other") {
      record("other");
    } else if (lazyCandidate) {
      // A lazy continuation: the paragraph of a container this line did not
      // continue takes it, and the containers stay open.
      if (leaf?.kind === "paragraph") addParagraphLine(leaf);
      record("paragraph");
    } else {
      closeContainersFrom(matched);
      if (!leafMatched) closeLeaf();
      if (leafMatched && leaf?.kind === "paragraph") {
        addParagraphLine(leaf);
        record("paragraph");
      } else if (leafMatched && leaf?.kind === "table") {
        record("table");
      } else if (!blank && pos < line.length) {
        markFilled();
        const content = line.slice(pos);
        leaf = {
          kind: "paragraph",
          lastLine: content,
          lastIndent: lineIndent,
          onlyDefinitions: LINK_DEFINITION.test(content),
        };
        record("paragraph");
      } else {
        record("blank");
      }
    }

    if ((leaf as OpenLeaf | null)?.kind === "indented") {
      if ((leaf as { oneLine: boolean }).oneLine) leaf = null;
    }
    lineStart = nextStart;
    if (!match) break;
  }
  if (openFence) closeFence(text.length, text.length, false);
  return { fences, lines };
}

/** A list marker at the start of `rest`, or `null`. */
function listMarker(
  rest: string,
): { length: number; mayInterrupt: boolean } | null {
  if (BULLET.test(rest)) return { length: 1, mayInterrupt: true };
  const ordered = ORDERED.exec(rest);
  if (!ordered) return null;
  return {
    length: ordered[0].length,
    // Exactly "1": micromark counts the digits, so "01." does not.
    mayInterrupt: ordered[1] === "1",
  };
}

const LOOSE_OPENING = /^[ \t]*(`{3,}|~{3,})[ \t]*([^\s`]*)/;

interface Opening {
  start: number;
  reason: UnreadProtocolBlockReason;
  /** The run that opened it, for finding where a literal one ends. */
  run: string;
  /** Index of its line in the scan. */
  index: number;
}

/** Opening lines of the `tags` that are not a closed block of the reply's own. */
function unreadOpenings(
  scan: ScanResult,
  text: string,
  tags: readonly string[],
): Opening[] {
  const openings: Opening[] = [];
  for (const [index, line] of scan.lines.entries()) {
    let run: string;
    let tag: string;
    if (line.role === "fence" && line.fence) {
      run = line.fence.fence;
      tag = languageOf(line.fence.info);
    } else {
      const loose = LOOSE_OPENING.exec(text.slice(line.content, line.end));
      if (!loose) continue;
      run = loose[1];
      tag = languageOf(loose[2]);
    }
    if (!tags.includes(tag)) continue;
    const reason = unreadReason(line);
    if (reason) openings.push({ start: line.start, reason, run, index });
  }
  return openings;
}

function unreadReason(line: ScannedLine): UnreadProtocolBlockReason | null {
  if (line.role === "fenceContent" || line.role === "indented") return "code";
  if (line.role === "math") return "math";
  if (line.role === "html") return "html";
  const outermost = line.containers[0];
  if (outermost === "quote") return "quote";
  if (outermost === "list") return "list";
  if (outermost === "footnote") return "footnote";
  if (line.role === "fence") return line.fence?.closed ? null : "unclosed";
  return "text";
}

// ---- stripping protocol blocks out of quoted text -----------------------------

/**
 * The protocol tags a report may never smuggle into a digest.
 *
 * `distill-recall` is absent on purpose: its parser reads only the
 * conductor's own turns, so there is nothing to launder.
 */
const PROTOCOL_FENCE_TAGS: readonly string[] = [
  "distill-wave",
  "distill-verdict",
  "distill-report",
  "distill-memory",
  GOAL_STATE_FENCE,
  LOOP_STATE_FENCE,
];

const collapsedOpening = new RegExp(
  `(?:\`{3,}|~{3,})[ \\t]*(?:${PROTOCOL_FENCE_TAGS.join("|")})(?=[\\s\`]|$)`,
  "i",
);

const PROTOCOL_BLOCK_REMOVED = "[protocol block removed]";

/**
 * Removes protocol blocks from text that is about to be quoted into a digest
 * or shown as a preview.
 *
 * A worker's summary is free-form prose and can quote anything, including a
 * `distill-wave` block. Such a block could never *run* — a digest is a user
 * message and the plan detector only ever scans assistant messages — but the
 * conductor reading the digest is a model, and a plan-shaped block inside a
 * report it is asked to judge is an invitation to echo it back. Ordinary code
 * blocks are left exactly as they are; only the protocol tags are cut.
 *
 * `distill-memory` is cut for the sharpest version of that echo: the memory
 * scanner refuses a worker's fence but honors the conductor's, so a memory
 * request smuggled through a report and repeated back by the conductor would
 * be laundered into exactly the write the ACL refused at the source.
 *
 * What is cut comes from the reader itself, so the strip can never leave a
 * block the app would act on: every block `protocolBlocks` would take, in
 * any spelling it takes, and every opening `unreadProtocolBlocks` reports —
 * a block in a quotation or a list, or quoted inside another code block — so
 * that a conductor echoing the text back does not hand a quoted plan a top
 * level of its own. The strip used to look for its own opening line, three
 * backticks only, and passed a `~~~distill-memory` block the reader took.
 *
 * A protocol block that is never closed is cut to the end of the text: from
 * the model's point of view everything after the opening line is inside the
 * block, and half a smuggled plan plus the conductor's own closing fence is
 * still a plan.
 */
export function stripProtocolFences(
  text: string,
  mode: "digest" | "preview" = "digest",
): string {
  const preview = mode === "preview";
  if (!text.includes("```") && !text.includes("~~~")) {
    return preview ? text : text.trim();
  }
  let result = text;
  // A streamed or capped preview may cut the opening tag in half.
  if (preview) {
    const tail = /(?:`{3,}|~{3,})[ \t]*([\w-]+)\u2026?$/.exec(result);
    if (
      tail &&
      PROTOCOL_FENCE_TAGS.some((tag) => tag.startsWith(tail[1].toLowerCase()))
    )
      result = result.slice(0, tail.index);
  }
  const spans =
    preview && !text.includes("\n")
      ? collapsedSpans(result)
      : protocolSpans(result);
  // Cut from the last span back, so every offset still points where it did.
  for (const span of spans.reverse()) {
    result = `${result.slice(0, span.start)}${preview ? "" : PROTOCOL_BLOCK_REMOVED}${result.slice(span.end)}`;
  }
  return preview ? result : result.trim();
}

interface Span {
  start: number;
  end: number;
}

/**
 * Where the protocol blocks of `text` are, at any depth: a fenced block
 * whose language is a protocol tag from its opening line to its closing one,
 * and an opening inside other text to the next line that would close it.
 */
function protocolSpans(text: string): Span[] {
  const lower = text.toLowerCase();
  const tags = PROTOCOL_FENCE_TAGS.filter((tag) => lower.includes(tag));
  if (tags.length === 0) return [];
  const scan = scanBlocks(text);
  const spans: Span[] = scan.fences
    .filter((fence) => tags.includes(languageOf(fence.info)))
    .map((fence) => ({ start: fence.start, end: fence.end }));
  for (const opening of unreadOpenings(scan, text, tags)) {
    const line = scan.lines[opening.index];
    if (line.role === "fence") continue; // a fenced block, cut above
    spans.push({
      start: opening.start,
      end: literalBlockEnd(scan, text, opening),
    });
  }
  return mergeSpans(spans);
}

/** The end of the line that closes an opening quoted inside other text. */
function literalBlockEnd(scan: ScanResult, text: string, opening: Opening) {
  const char = opening.run[0];
  for (const line of scan.lines.slice(opening.index + 1)) {
    const close = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/.exec(
      text.slice(line.content, line.end),
    );
    if (close && close[1][0] === char && close[1].length >= opening.run.length)
      return line.end;
  }
  return text.length;
}

/** List snippets have already lost their line boundaries. */
function collapsedSpans(text: string): Span[] {
  const spans: Span[] = [];
  const pattern = new RegExp(collapsedOpening.source, "gi");
  let match = pattern.exec(text);
  while (match) {
    const runEnd = match.index + (/^[`~]+/.exec(match[0])?.[0].length ?? 3);
    const run = text.slice(match.index, runEnd);
    const close = text.indexOf(run, match.index + match[0].length);
    const end = close < 0 ? text.length : close + run.length;
    spans.push({ start: match.index, end });
    pattern.lastIndex = end;
    match = pattern.exec(text);
  }
  return spans;
}

function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}
