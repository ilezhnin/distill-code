/**
 * Reading someone else's memory file into this one.
 *
 * Every assistant that keeps standing instructions keeps them as markdown a
 * person wrote by hand: `CLAUDE.md`, `AGENTS.md`, the notes under
 * `~/.codex/memories/`. An operator arriving with one of those already knows
 * what they want remembered, and retyping thirty bullets into the add field is
 * the reason they would not bother.
 *
 * So this reads markdown and nothing else. No JSON export format of any other
 * product is parsed: those carry ids, scopes and timestamps that mean
 * something in the tool that wrote them and nothing here, and a shape we guess
 * at wrong imports facts the operator never wrote. Markdown is the one format
 * all of them agree on, and the one the operator can read before importing.
 *
 * It proposes, it does not import. What comes back is a list of candidates the
 * panel shows with a checkbox each; the writing is the operator's click, and
 * it goes through `remember` like everything else, with every check that path
 * makes. A line that trips `findSecret` never becomes a candidate at all —
 * showing it, even to be refused, would put a key on screen and into the
 * component tree of a page that is not otherwise allowed to hold one. How many
 * were dropped is said; which ones were is not.
 *
 * Pure. The file picker and the store are the panel's.
 */

import {
  MAX_MEMORY_TEXT,
  normalizeMemoryText,
  sameMemoryText,
} from "./memoryEntry";
import { findSecret } from "./memoryRedaction";

/** What one file offered, and what was quietly kept out of the offer. */
export interface MemoryImportScan {
  /** Statements to show, normalized exactly as they would be stored. */
  candidates: string[];
  /**
   * How many statements were dropped for carrying a key or a token.
   *
   * A number, never the lines. The count is worth saying — an import that
   * silently loses four bullets looks like a broken parser — but the shape of
   * a secret is the most the app may ever repeat about one.
   */
  refusedSecrets: number;
}

/** A fenced code block's opening or closing run. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** `#` through `######`, the heading forms that carry no fact of their own. */
const HEADING = /^ {0,3}#{1,6}(\s|$)/;
/** `---`, `***`, `___` — a rule, and the delimiter of a YAML front matter. */
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
/** A setext underline: the heading above it was already skipped as prose. */
const SETEXT = /^ {0,3}=+\s*$/;
/** `-`, `*`, `+` or `1.` / `1)`, at any depth. */
const BULLET = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(.*)$/;
/** A task list's own marker, which is state and not statement. */
const TASK_MARKER = /^\[[ xX]\]\s*/;
const BLOCKQUOTE = /^ {0,3}>/;
const TABLE_ROW = /^ {0,3}\|/;
/** Raw HTML and comments: markup, and often a note to the file's own reader. */
const HTML_LINE = /^ {0,3}</;

/** Tabs count as four columns, the width that makes a line a code block. */
function indentOf(line: string): number {
  let width = 0;
  for (const character of line) {
    if (character === " ") width += 1;
    else if (character === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
}

interface Pending {
  text: string;
  /**
   * A bullet is taken however long it runs; a paragraph is not.
   *
   * "Short paragraphs" is the whole licence prose has here. A bullet in one of
   * these files is already a statement someone wrote to be read on its own, so
   * an overlong one is offered as it would be stored — cut at the bound, with
   * the cut visible in the checkbox list. A long paragraph is an explanation,
   * and its first 280 characters are not a fact, they are a fragment.
   */
  fromBullet: boolean;
}

/** A prose line, either opening a paragraph or continuing what came before. */
function continued(open: Pending | null, line: string): Pending {
  if (!open) return { text: line, fromBullet: false };
  return { text: `${open.text} ${line}`, fromBullet: open.fromBullet };
}

/**
 * The candidates a markdown file offers, in the order they appear in it.
 *
 * Skipped outright: headings (a title is not a fact), fenced and indented code
 * (a snippet in the prompt block is a snippet in every prompt), horizontal
 * rules, YAML front matter, table rows and raw HTML.
 *
 * Blockquotes are skipped too, and that is a judgement worth naming: a quote
 * in one of these files is something quoted from elsewhere — a spec, an error,
 * another agent — and importing it stores it as the operator's own standing
 * fact, which is the one thing it is not.
 *
 * Nested bullets are taken flat, at every depth. Nesting in a `CLAUDE.md`
 * groups statements under a heading-ish parent; it does not make the child
 * less of a statement, and there is nowhere in a memory list for a hierarchy
 * to survive anyway. Numbered lists are taken the same way, marker stripped:
 * "1." is the order in that file, not part of the fact.
 *
 * A line indented four columns or more is code unless it is a bullet — which
 * is what tells a nested list item apart from a snippet nobody fenced.
 */
export function scanMemoryImport(text: string): MemoryImportScan {
  const candidates: string[] = [];
  let refusedSecrets = 0;
  let pending: Pending | null = null;

  const flush = () => {
    if (!pending) return;
    const { text: raw, fromBullet } = pending;
    pending = null;
    const normalized = normalizeMemoryText(raw);
    if (!normalized) return;
    // Measured before the bound cuts it: `normalizeMemoryText` always comes
    // back within 280, so asking the normalized line how long it was is asking
    // the wrong witness.
    if (!fromBullet && raw.replace(/\s+/g, " ").trim().length > MAX_MEMORY_TEXT)
      return;
    // The raw line is what is scanned, for the reason the store gives: cutting
    // a statement to the bound can take away the `-----BEGIN` or the `=` that
    // gave the key away.
    if (findSecret(raw)) {
      refusedSecrets += 1;
      return;
    }
    // The same statement written twice in one file is one memory. Matched the
    // way the store matches it, so what the panel offers is what would survive
    // being kept.
    if (candidates.some((existing) => sameMemoryText(existing, normalized))) {
      return;
    }
    candidates.push(normalized);
  };

  const lines = text.split(/\r?\n/);
  let index = 0;
  // Front matter, when the file opens with one. Codex writes memories with a
  // YAML head; its keys are the file's metadata, not the operator's facts.
  if (lines.length > 1 && RULE.test(lines[0]) && lines[0].trim()[0] === "-") {
    const closing = lines.findIndex(
      (line, at) => at > 0 && RULE.test(line) && line.trim()[0] === "-",
    );
    if (closing > 0) index = closing + 1;
  }

  let inFence = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index];

    if (FENCE.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (!line.trim()) {
      flush();
      continue;
    }

    if (
      HEADING.test(line) ||
      RULE.test(line) ||
      SETEXT.test(line) ||
      BLOCKQUOTE.test(line) ||
      TABLE_ROW.test(line) ||
      HTML_LINE.test(line)
    ) {
      flush();
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flush();
      pending = { text: bullet[1].replace(TASK_MARKER, ""), fromBullet: true };
      continue;
    }

    // Four columns in with nothing open above it: a code block nobody fenced.
    // With something open above it, the same indent is that statement's second
    // line — which is why the bullet case is answered first and the emptiness
    // of `pending` decides here.
    if (pending === null && indentOf(line) >= 4) continue;

    // Plain prose. Indented or not, a line following something unfinished is
    // its continuation — markdown's lazy continuation, and the reason a bullet
    // wrapped over two lines arrives as one candidate rather than two.
    pending = continued(pending, line.trim());
  }
  flush();

  return { candidates, refusedSecrets };
}

/**
 * Just the statements, for a caller that has no use for the refusal count.
 *
 * The signature the panel's list is built from; `scanMemoryImport` is the same
 * pass with the number the panel says out loud underneath it.
 */
export function extractCandidates(text: string): string[] {
  return scanMemoryImport(text).candidates;
}
