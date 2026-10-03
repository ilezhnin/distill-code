/**
 * A rendering of a captured output for the blind reviewer's eyes: SVG and
 * HTML only, scripts and network removed by policy, nothing else interpreted.
 */

const OPENING_FENCE = /^```[a-z]*[ \t]*\r?\n/i;
const CLOSING_FENCE = /\r?\n```[ \t]*$/;

/** A content security policy that leaves a document with its inline styles and nothing else. */
const POLICY =
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">";

export interface RubricCriterion {
  id: string;
  label: string;
  weight: number;
}

export interface RenderableMarkup {
  kind: "svg" | "html";
  body: string;
}

/** Criterion scores from legacy reviews or a versioned judge response. */
export function evaluationCriteria(
  details: Record<string, unknown> | null | undefined,
): [string, number][] {
  if (!details) return [];
  const values = details.criteria ?? details;
  if (!values || typeof values !== "object" || Array.isArray(values)) return [];
  return Object.entries(values).filter(
    (entry): entry is [string, number] =>
      typeof entry[1] === "number" &&
      Number.isFinite(entry[1]) &&
      entry[1] >= 0 &&
      entry[1] <= 1,
  );
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

/** The markup without a Markdown fence on either side; a lone opening fence counts too. */
function unfence(text: string): string {
  let body = text.trim();
  const opening = OPENING_FENCE.exec(body);
  if (opening) body = body.slice(opening[0].length);
  const closing = CLOSING_FENCE.exec(body);
  if (closing) body = body.slice(0, closing.index);
  return body.trim();
}

/** The drawing or page inside an output, or null when the output is neither. */
export function renderable(
  output: string | null | undefined,
  format: string | null | undefined,
): RenderableMarkup | null {
  if (!output) return null;
  const body = unfence(output);
  const lowered = body.slice(0, 200).toLowerCase();
  if (
    lowered.startsWith("<svg") ||
    (format === "svg" && lowered.includes("<svg"))
  )
    return { kind: "svg", body };
  if (
    lowered.startsWith("<!doctype html") ||
    lowered.startsWith("<html") ||
    (format === "html" && lowered.includes("<"))
  )
    return { kind: "html", body };
  return null;
}

/**
 * A standalone HTML document that shows the output, or null when the output
 * is not a drawing or a page.
 */
export function previewDocument(
  output: string | null | undefined,
  format: string | null | undefined,
): string | null {
  const markup = renderable(output, format);
  if (!markup) return null;
  if (markup.kind === "svg") {
    return `<!doctype html><html><head><meta charset="utf-8">${POLICY}<style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#fff}svg{width:100%;height:auto;max-height:100%}</style></head><body>${markup.body}</body></html>`;
  }
  const head = /<head[^>]*>/i.exec(markup.body);
  if (head)
    return (
      markup.body.slice(0, head.index + head[0].length) +
      POLICY +
      markup.body.slice(head.index + head[0].length)
    );
  return `<!doctype html><html><head><meta charset="utf-8">${POLICY}</head><body>${markup.body}</body></html>`;
}
