/**
 * A rendering of a captured output for the blind reviewer's eyes: SVG and
 * HTML only, scripts and network removed by policy, nothing else interpreted.
 */

const OPENING_FENCE = /^```[a-z]*[ \t]*\r?\n/i;
const CLOSING_FENCE = /\r?\n```[ \t]*$/;

/** The markup without a Markdown fence on either side; a lone opening fence counts too. */
function unfence(text: string): string {
  let body = text.trim();
  const opening = OPENING_FENCE.exec(body);
  if (opening) body = body.slice(opening[0].length);
  const closing = CLOSING_FENCE.exec(body);
  if (closing) body = body.slice(0, closing.index);
  return body.trim();
}

/** A content security policy that leaves a document with its inline styles and nothing else. */
const POLICY =
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">";

export interface RubricCriterion {
  id: string;
  label: string;
  weight: number;
}

/** The weighted criteria a rubric task declares in its environment, or none. */
export function rubricCriteriaOf(environment: unknown): RubricCriterion[] {
  if (!environment || typeof environment !== "object") return [];
  const raw = (environment as { rubricCriteria?: unknown }).rubricCriteria;
  if (!Array.isArray(raw)) return [];
  const criteria: RubricCriterion[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { id, label, weight } = entry as Record<string, unknown>;
    if (
      typeof id === "string" &&
      id &&
      typeof label === "string" &&
      typeof weight === "number" &&
      weight > 0
    )
      criteria.push({ id, label, weight });
  }
  return criteria;
}

/** The weighted mean of per-criterion scores on a 0 to 10 scale, as a share from 0 to 1. */
export function weightedShare(
  criteria: RubricCriterion[],
  scores: Record<string, number>,
): number {
  const total = criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  if (total === 0) return 0;
  const weighted = criteria.reduce(
    (sum, criterion) => sum + (scores[criterion.id] ?? 0) * criterion.weight,
    0,
  );
  return Math.round((weighted / (10 * total)) * 1000) / 1000;
}

/**
 * A standalone HTML document that shows the output, or null when the output
 * is not a drawing or a page.
 */
export function previewDocument(
  output: string | null | undefined,
  format: string | null | undefined,
): string | null {
  if (!output) return null;
  const body = unfence(output);
  const lowered = body.slice(0, 200).toLowerCase();
  const svg =
    lowered.startsWith("<svg") ||
    (format === "svg" && lowered.includes("<svg"));
  const html =
    lowered.startsWith("<!doctype html") ||
    lowered.startsWith("<html") ||
    (format === "html" && lowered.includes("<"));
  if (svg) {
    return `<!doctype html><html><head><meta charset="utf-8">${POLICY}<style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#fff}svg{width:100%;height:auto;max-height:100%}</style></head><body>${body}</body></html>`;
  }
  if (html) {
    const head = /<head[^>]*>/i.exec(body);
    if (head)
      return (
        body.slice(0, head.index + head[0].length) +
        POLICY +
        body.slice(head.index + head[0].length)
      );
    return `<!doctype html><html><head><meta charset="utf-8">${POLICY}</head><body>${body}</body></html>`;
  }
  return null;
}
