/**
 * The protocol block reader against the transcript itself.
 *
 * A protocol block counts exactly when the transcript shows it as a
 * top-level fenced code block with the protocol's tag as its language. The
 * transcript renders a settled reply with Streamdown in static mode, which
 * parses the whole text once with remark-parse and the plugins below. That
 * pipeline is loaded here, through Streamdown's own dependency tree, and
 * every input is read by both: the reader, and each protocol's consumer, must
 * find the blocks the transcript shows, where it shows them, and no others.
 */
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import { defaultRemarkPlugins } from "streamdown";
import { beforeAll, describe, expect, it } from "vitest";

import { finalStateFence } from "@/features/chat-automation/commands";
import { scanFencedBlock } from "@/features/conductor/flockWave";
import { hasReportFence } from "@/features/conductor/orchestratorReport";
import { memoryFenceBodies } from "@/features/memory/lib/memoryFence";
import { parseRecallFence } from "@/features/memory/lib/memoryRecall";

import { protocolBlocks, topLevelFencedBlocks } from "./protocolFences";

// ---- the transcript's parser ------------------------------------------------

interface MdNode {
  type: string;
  lang?: string | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdNode[];
}
type Parse = (text: string) => MdNode;
let parseLikeTranscript: Parse;

beforeAll(async () => {
  // `streamdown` exports no package.json; its stylesheet sits beside it.
  const local = createRequire(join(process.cwd(), "package.json"));
  const streamdownDir = realpathSync(
    dirname(local.resolve("streamdown/styles.css")),
  );
  const fromStreamdown = createRequire(join(streamdownDir, "package.json"));
  const load = (name: string) =>
    import(/* @vite-ignore */ pathToFileURL(fromStreamdown.resolve(name)).href);
  const { unified } = await load("unified");
  const remarkParse = (await load("remark-parse")).default;
  // The plugin order of Streamdown's own processor (`Nt` in its bundle):
  // cjk before, the default remark plugins, cjk after, then math.
  const processor = unified()
    .use(remarkParse)
    .use([
      ...cjk.remarkPluginsBefore,
      ...Object.values(defaultRemarkPlugins),
      ...cjk.remarkPluginsAfter,
      math.remarkPlugin,
    ]);
  parseLikeTranscript = (text) =>
    processor.runSync(processor.parse(text), text) as MdNode;
});

/** One fenced block as both sides describe it. */
interface Shown {
  /** Offset of the opening line. */
  line: number;
  lang: string;
  closed: boolean;
  /** End of the closing line, for a closed block. */
  closeLineEnd: number | null;
}

const FENCE_RUN = /^ {0,3}(`{3,}|~{3,})/;
const CLOSER = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function lineStartOf(text: string, offset: number): number {
  let index = offset;
  while (index > 0 && text[index - 1] !== "\n" && text[index - 1] !== "\r") {
    index -= 1;
  }
  return index;
}

function lineEndOf(text: string, offset: number): number {
  const match = /\r\n|\r|\n/g;
  match.lastIndex = offset;
  const found = match.exec(text);
  return found ? found.index : text.length;
}

/** The fenced code blocks at the root of the transcript's tree. */
function transcriptBlocks(text: string): Shown[] {
  const shown: Shown[] = [];
  for (const node of parseLikeTranscript(text).children ?? []) {
    if (node.type !== "code") continue;
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? text.length;
    const line = lineStartOf(text, start);
    const opening = FENCE_RUN.exec(text.slice(line, lineEndOf(text, line)));
    if (!opening) continue; // an indented code block
    const lastLineStart = lineStartOf(text, end);
    const last = CLOSER.exec(text.slice(lastLineStart, lineEndOf(text, end)));
    const closed =
      lastLineStart > line &&
      last !== null &&
      last[1][0] === opening[1][0] &&
      last[1].length >= opening[1].length;
    shown.push({
      line,
      lang: (node.lang ?? "").toLowerCase(),
      closed,
      closeLineEnd: closed ? lineEndOf(text, end) : null,
    });
  }
  return shown;
}

function readerBlocks(text: string): Shown[] {
  return topLevelFencedBlocks(text)
    .filter((block) => block.fence[0] !== "$")
    .map((block) => ({
      line: block.start,
      lang: (block.info.split(/[ \t]/)[0] ?? "").toLowerCase(),
      closed: block.closed,
      closeLineEnd: block.closed ? block.end : null,
    }));
}

// ---- what each protocol's consumer does with a reply ------------------------

const PLAN = '{"steps":[{"role":"coder","subtask":"Fix the bug","access":[]}]}';

interface Kind {
  tag: string;
  body: string;
  /** What the app does with the text, in a form the transcript predicts. */
  acted: (text: string) => string;
  /** The same, predicted from the blocks the transcript shows. */
  expected: (blocks: Shown[], text: string) => string;
}

function scanned(text: string, tag: string): string {
  return scanFencedBlock(text, tag).kind;
}
function scanExpected(blocks: Shown[]): string {
  if (blocks.length === 0) return "none";
  if (blocks.length > 1) return "multiple";
  return blocks[0].closed ? "one" : "unterminated";
}
const closedCount = (blocks: Shown[]) =>
  String(blocks.filter((block) => block.closed).length);
const anyClosed = (blocks: Shown[]) =>
  String(blocks.some((block) => block.closed));
/**
 * The goal and loop protocols ask the agent to end its reply with the state
 * block, and only a block that does is read: its own rule, on top of where
 * the block stands.
 */
const endsReply = (blocks: Shown[], text: string) => {
  const last = blocks.at(-1);
  return String(
    last?.closeLineEnd != null && text.slice(last.closeLineEnd).trim() === "",
  );
};

const KINDS: Kind[] = [
  {
    tag: "distill-wave",
    body: PLAN,
    acted: (text) => scanned(text, "distill-wave"),
    expected: scanExpected,
  },
  {
    tag: "distill-verdict",
    body: '{"verdict":"accept"}',
    acted: (text) => scanned(text, "distill-verdict"),
    expected: scanExpected,
  },
  {
    tag: "distill-roadmap",
    body: '{"goal":"Ship","status":"in-progress","stages":[]}',
    acted: (text) => scanned(text, "distill-roadmap"),
    expected: scanExpected,
  },
  {
    tag: "distill-report",
    body: '{"status":"completed","summary":"Done."}',
    acted: (text) => String(hasReportFence(text)),
    expected: anyClosed,
  },
  {
    tag: "distill-memory",
    body: "remember: The build uses pnpm.",
    acted: (text) => String(memoryFenceBodies(text).length),
    expected: closedCount,
  },
  {
    tag: "distill-recall",
    body: '{"query":"build tool","scope":"project"}',
    acted: (text) => String(parseRecallFence(text) !== null),
    expected: anyClosed,
  },
  {
    tag: "flock-goal-state",
    body: '{"status":"continue","note":"next"}',
    acted: (text) => String(finalStateFence(text, "flock-goal-state") !== null),
    expected: endsReply,
  },
  {
    tag: "flock-loop-state",
    body: '{"delay":"5m","note":"again"}',
    acted: (text) => String(finalStateFence(text, "flock-loop-state") !== null),
    expected: endsReply,
  },
];

// ---- the corpus ---------------------------------------------------------------

/** How a block's opening line may be written. `$T` is the tag. */
const SPELLINGS = [
  "```$T",
  "``` $T",
  "```\t$T  ",
  "```$U",
  "```$T json",
  "````$T",
  "~~~$T",
  "~~~ $T `x`",
];

function block(spelling: string, tag: string, body: string): string {
  const opening = spelling.replace("$T", tag).replace("$U", tag.toUpperCase());
  const run = /^[`~]+/.exec(opening)?.[0] ?? "```";
  return `${opening}\n${body}\n${run}`;
}

const QUOTED_DOC = [
  "Here is the brief I will hand out:",
  "```markdown",
  "# Brief",
  "Run the tests:",
  "```bash",
  "npm test",
  "```",
  "```",
  "",
].join("\n");

const indent = (text: string, pad: string) =>
  text
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");

/** Where a block may stand in a reply. `B` is the block. */
const PLACES: Record<string, (b: string) => string> = {
  alone: (b) => b,
  afterProse: (b) => `I will launch one worker.\n\n${b}`,
  interruptsParagraph: (b) => `Plan:\n${b}`,
  trailingText: (b) => `Plan:\n\n${b}\n\nBack soon.`,
  indent1: (b) => indent(b, " "),
  indent2: (b) => `Plan:\n\n${indent(b, "  ")}`,
  indent3: (b) => indent(b, "   "),
  indent4: (b) => indent(b, "    "),
  indentTab: (b) => indent(b, "\t"),
  afterListNoBlank: (b) => `Steps:\n1. code\n2. test\n${b}`,
  afterListBlank: (b) => `Steps:\n- code\n- test\n\n${b}`,
  afterLazyListLine: (b) => `Steps:\n- code\nmore text\n\n${b}`,
  inListItem: (b) => `- Do this:\n${indent(b, "  ")}`,
  inListItemAfterBlank: (b) => `- Do this:\n\n${indent(b, "  ")}`,
  wideListItemShallowBlock: (b) => `-   Do this:\n\n${indent(b, "  ")}`,
  inOrderedItem: (b) => `1. Do this:\n${indent(b, "   ")}`,
  inNestedList: (b) => `- outer\n  - inner\n${indent(b, "    ")}`,
  listItemIsBlock: (b) => `- ${b.split("\n").join("\n  ")}`,
  afterQuoteBlank: (b) => `> note from the operator\n\n${b}`,
  afterQuoteNoBlank: (b) => `> note from the operator\n${b}`,
  afterQuoteLazy: (b) => `> note\nstill the note\n${b}`,
  inQuote: (b) => indent(b, "> "),
  inQuoteNoSpace: (b) => indent(b, ">"),
  inQuoteInList: (b) => `- item\n${indent(b, "  > ")}`,
  afterQuotedNestedDoc: (b) => `${QUOTED_DOC}Now the plan:\n\n${b}`,
  afterTable: (b) => `| a | b |\n|---|---|\n| 1 | 2 |\n\n${b}`,
  afterTableNoBlank: (b) => `| a | b |\n|---|---|\n| 1 | 2 |\n${b}`,
  afterTildeDivider: (b) => `Summary of the last wave.\n~~~~~~~~~~\n\n${b}`,
  inTildeWrapper: (b) => `~~~\n${b}\n~~~`,
  inFourBacktickWrapper: (b) => `\`\`\`\`markdown\n${b}\n\`\`\`\``,
  afterFourBacktickWrapper: (b) => `\`\`\`\`\n${b}\n\`\`\`\`\n\n${b}`,
  inUnclosedFence: (b) => `\`\`\`text\n${b}`,
  inMath: (b) => `$$\n${b}\n$$`,
  afterMath: (b) => `$$\nx^2\n$$\n${b}`,
  afterDollarLine: (b) => `Budget:\n$$ spent so far: 12\n\n${b}`,
  afterInlineMathLine: (b) => `Cost $$x$$ today.\n${b}`,
  afterBoldHeading: (b) => `**Wave 2**\n${b}`,
  afterAtxHeading: (b) => `## Wave 2\n${b}`,
  afterSetextHeading: (b) => `Wave 2\n------\n${b}`,
  afterThematicBreak: (b) => `Done.\n\n***\n${b}`,
  afterHtmlComment: (b) => `<!-- wave 2 -->\n${b}`,
  inHtmlComment: (b) => `<!--\n${b}\n-->`,
  afterOpenComment: (b) => `<!--\nnote\n-->\n${b}`,
  inDiv: (b) => `<div>\n${b}\n</div>`,
  afterDivBlank: (b) => `<div>\nx\n\n${b}`,
  inPre: (b) => `<pre>\n\n${b}\n</pre>`,
  afterCustomTagLine: (b) => `<custom-tag>\n${b}`,
  afterSpanLine: (b) => `<span class="note">\n${b}`,
  afterTagLine: (b) => `<status>ready</status>\n${b}`,
  afterAutolinkLine: (b) =>
    `Tracking issue:\n<https://example.com/issues/12>\n${b}`,
  afterBrInParagraph: (b) => `Two workers, one wave.\n<br>\n${b}`,
  afterBrAlone: (b) => `Done.\n\n<br>\n${b}`,
  afterFootnote: (b) => `See [^1].\n\n[^1]: The source.\n${b}`,
  inFootnote: (b) => `[^1]: The source.\n${indent(b, "    ")}`,
  afterLinkDefinition: (b) => `[home]: https://example.com\n${b}`,
  midSentence: (b) => `The file says ${b.split("\n").join(" ")} at the end.`,
  oneLine: (b) => b.split("\n").join(" "),
  closedOnLastLine: (b) => b.replace(/\n(`{3,}|~{3,})$/, "$1"),
  missingClose: (b) => b.replace(/\n(`{3,}|~{3,})$/, ""),
  closerIndented4: (b) => b.replace(/\n(`{3,}|~{3,})$/, "\n    $1"),
  closerTrailingSpaces: (b) => `${b}   `,
  closerLonger: (b) => b.replace(/\n(`{3,}|~{3,})$/, "\n$1$1"),
  wrongCloser: (b) =>
    b.replace(
      /\n(`{3,}|~{3,})$/,
      (_, run: string) => `\n${run[0] === "`" ? "~~~" : "```"}`,
    ),
  twoBlocks: (b) => `${b}\n\nAnd again:\n\n${b}`,
  quotedThenOwn: (b) =>
    `The page I read carries this:\n\n${indent(b, "> ")}\n\n${b}`,
  finalNewline: (b) => `Plan:\n\n${b}\n`,
  crlf: (b) =>
    `I will launch one worker.\r\n\r\n${b.replace(/\n/g, "\r\n")}\r\n`,
  crlfInList: (b) => `- item\r\n${indent(b, "  ").replace(/\n/g, "\r\n")}`,
  loneCr: (b) => `Plan:\r\r${b.replace(/\n/g, "\r")}`,
};

interface Input {
  name: string;
  text: string;
  kind: Kind;
}

function corpus(): Input[] {
  const inputs: Input[] = [];
  for (const kind of KINDS) {
    for (const spelling of SPELLINGS) {
      const b = block(spelling, kind.tag, kind.body);
      for (const [place, build] of Object.entries(PLACES)) {
        inputs.push({
          name: `${kind.tag} ${JSON.stringify(spelling)} ${place}`,
          text: build(b),
          kind,
        });
      }
    }
  }
  return inputs;
}

/**
 * A reply as it streams: every prefix cut at a chunk boundary, each read as
 * the transcript would show that much of it.
 */
function streamedPrefixes(text: string, chunk: number): string[] {
  const prefixes: string[] = [];
  for (let end = chunk; end < text.length; end += chunk) {
    prefixes.push(text.slice(0, end));
  }
  prefixes.push(text);
  return prefixes;
}

/** Random replies from lines that change where a fence stands. */
function fuzzCorpus(count: number, seed: number): string[] {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(next() * items.length)];
  const LINES = [
    "```distill-wave",
    "```",
    "````",
    "~~~",
    "~~~~",
    "```text",
    "~~~ `x`",
    "``` distill-memory note",
    "````distill-report",
    "$$",
    "$$$",
    "$$ a",
    "{}",
    "text",
    "more text",
    "",
    "",
    " ",
    "- item",
    "  - nested",
    "1. one",
    "2) two",
    "* star",
    "+ plus",
    "-",
    "1.",
    "> quote",
    ">",
    "> ```",
    "> - x",
    ">> deep",
    "    indented",
    "\tTab",
    "  ```distill-wave",
    "   ```",
    "    ```",
    "  ~~~",
    "<div>",
    "</div>",
    "<!-- c",
    "-->",
    "<!-- x -->",
    "<status>ok</status>",
    "<br>",
    "<https://example.com/a>",
    '<span class="x">',
    "</span>",
    "<pre>",
    "</pre>",
    "<?php",
    "?>",
    "<!DOCTYPE html>",
    "<![CDATA[",
    "]]>",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "a | b",
    "--|--",
    "---",
    "===",
    "***",
    "# h",
    "[^1]: note",
    "[a]: /url",
    "  text",
    "   1. x",
    "10. ten",
    "- [ ] task",
    "  > q",
    "     five",
    "-    wide",
    "  ```",
    "\t```distill-wave",
    "` code `",
  ];
  const docs: string[] = [];
  for (let doc = 0; doc < count; doc += 1) {
    const lines: string[] = [];
    const length = 3 + Math.floor(next() * 10);
    for (let line = 0; line < length; line += 1) lines.push(pick(LINES));
    const joined = lines.join(next() < 0.15 ? "\r\n" : "\n");
    docs.push(next() < 0.3 ? `${joined}\n` : joined);
  }
  return docs;
}

// ---- comparison ----------------------------------------------------------------

interface Disagreement {
  name: string;
  text: string;
  transcript: unknown;
  app: unknown;
}

function compareBlocks(name: string, text: string): Disagreement | null {
  const transcript = transcriptBlocks(text);
  const app = readerBlocks(text);
  return JSON.stringify(transcript) === JSON.stringify(app)
    ? null
    : { name, text, transcript, app };
}

function compareKind(input: Input): Disagreement | null {
  const shown = transcriptBlocks(input.text).filter(
    (candidate) => candidate.lang === input.kind.tag,
  );
  const expected = input.kind.expected(shown, input.text);
  const acted = input.kind.acted(input.text);
  const found = protocolBlocks(input.text, input.kind.tag).map(
    (candidate) => candidate.start,
  );
  const shownAt = shown.map((candidate) => candidate.line);
  if (acted === expected && JSON.stringify(found) === JSON.stringify(shownAt)) {
    return null;
  }
  return {
    name: input.name,
    text: input.text,
    transcript: { expected, at: shownAt },
    app: { acted, at: found },
  };
}

function summarize(label: string, compared: number, found: Disagreement[]) {
  console.log(
    `${label}: ${compared} inputs compared, ${found.length} disagreements`,
  );
  for (const item of found.slice(0, 12)) {
    console.log(JSON.stringify(item));
  }
}

/**
 * Why a reply whose block the transcript shows is still not run: the
 * protocol's own rules, which the corpus keeps in view.
 */
function shownNotRun(input: Input): string | null {
  const shown = transcriptBlocks(input.text).filter(
    (candidate) => candidate.lang === input.kind.tag,
  );
  if (shown.length === 0) return null;
  const acted = input.kind.acted(input.text);
  if (acted === "one" || acted === "true" || /^[1-9]/.test(acted)) return null;
  if (acted === "multiple") return "two blocks in one reply";
  if (shown.every((candidate) => !candidate.closed)) return "never closed";
  return "a state block followed by more text";
}

describe("the protocol block reader against the transcript", () => {
  it("finds exactly the protocol blocks the transcript shows, for every kind, spelling and place", () => {
    const inputs = corpus();
    const found = inputs
      .map(compareKind)
      .filter((item): item is Disagreement => item !== null);
    summarize("protocol corpus", inputs.length, found);
    const notRun = new Map<string, number>();
    for (const input of inputs) {
      const why = shownNotRun(input);
      if (!why) continue;
      const key = `${why}: ${input.kind.tag}`;
      notRun.set(key, (notRun.get(key) ?? 0) + 1);
    }
    console.log(
      `shown but not run, by the protocol's own rule: ${JSON.stringify(Object.fromEntries(notRun))}`,
    );
    expect(found).toEqual([]);
  });

  it("finds the transcript's top-level fenced blocks in every corpus reply", () => {
    const texts = [...new Set(corpus().map((input) => input.text))];
    const found = texts
      .map((text, index) => compareBlocks(`corpus #${index}`, text))
      .filter((item): item is Disagreement => item !== null);
    summarize("block corpus", texts.length, found);
    expect(found).toEqual([]);
  });

  it("agrees with the transcript at every point of a reply streamed in chunks", () => {
    const replies = [
      `I will launch one worker.\n\n${block("```$T", "distill-wave", PLAN)}\n\nBack soon.`,
      `${QUOTED_DOC}Now the plan:\n\n${block("```$T", "distill-wave", PLAN)}`,
      `Notes:\n- one\n- two\n\n> quoted\n${block("~~~$T", "distill-memory", "remember: x")}\n${block("```$T", "distill-report", '{"status":"completed"}')}`,
      `<status>ready</status>\n${block("```$T", "distill-verdict", '{"verdict":"accept"}')}\r\nDone.`,
    ];
    let compared = 0;
    const found: Disagreement[] = [];
    for (const [index, reply] of replies.entries()) {
      for (const chunk of [1, 7, 64]) {
        for (const prefix of streamedPrefixes(reply, chunk)) {
          compared += 1;
          const disagreement = compareBlocks(
            `stream #${index} chunk ${chunk} at ${prefix.length}`,
            prefix,
          );
          if (disagreement) found.push(disagreement);
        }
      }
    }
    summarize("streamed prefixes", compared, found);
    expect(found).toEqual([]);
  });

  it("finds the transcript's top-level fenced blocks in random replies", () => {
    const docs = fuzzCorpus(4000, 20261125);
    const found = docs
      .map((text, index) => compareBlocks(`fuzz #${index}`, text))
      .filter((item): item is Disagreement => item !== null);
    summarize("random replies", docs.length, found);
    expect(found).toEqual([]);
  });
});
