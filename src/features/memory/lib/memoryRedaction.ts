/**
 * The one thing memory must never keep: a secret.
 *
 * A memory is not a note in a file the operator alone reads. It is copied
 * into every later system prompt, sent to whichever provider that session
 * talks to, and mirrored into each project's own folder — so a token that
 * reaches `memory.json` has already left the machine several times over by
 * the time anyone notices it there. The fence makes that one turn away: an
 * agent reading a `.env` out loud and deciding the line is worth keeping.
 *
 * Refusal, not redaction. A statement that trips one of these patterns is
 * dropped whole; the app never stores an edited version of it
 * (LAWS/MEMORY.md, Writing). Rewriting a secret into a "safe" line would
 * guess at what the operator meant and keep the half we guessed wrong about.
 *
 * Shape-matching only — known prefixes, assignments, and runs long enough to
 * be a key rather than a word. No entropy score: the cost of a false positive
 * is one refused sentence the operator can rephrase, and the cost of a
 * heuristic nobody can predict is an operator who stops trusting the panel.
 *
 * Pure. Callers are the store (which refuses) and the sync (which says so).
 */

/**
 * What a refused statement looked like. The kind is the only thing that may
 * be spoken about a secret — never the value, and never the statement.
 */
export const SECRET_KINDS = [
  "private-key",
  "aws-key",
  "github-token",
  "slack-token",
  "provider-key",
  "jwt",
  "password-assignment",
  "url-credentials",
  "long-hex",
  "long-base64",
] as const;

export type SecretKind = (typeof SECRET_KINDS)[number];

/**
 * Ordered: the first match wins, and the specific shapes come before the
 * generic ones so a refusal names what it actually saw. A GitHub token is
 * also a long run of letters and digits; being told "github-token" is worth
 * more to whoever reads the warning than "long-base64".
 */
const SECRET_PATTERNS: readonly { kind: SecretKind; pattern: RegExp }[] = [
  { kind: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "aws-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "github-token", pattern: /\bghp_[A-Za-z0-9]{36}\b/ },
  { kind: "github-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { kind: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "provider-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  },
  {
    // The value is what makes it a secret: `password:` with something after
    // it, not the word on its own. "the password policy changed" stays.
    kind: "password-assignment",
    pattern:
      /(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*['"]?[^\s'"]{8,}/i,
  },
  { kind: "url-credentials", pattern: /\/\/[^/\s:]+:[^@\s]+@/ },
  { kind: "long-hex", pattern: /\b[0-9a-fA-F]{40,}\b/ },
  { kind: "long-base64", pattern: /[A-Za-z0-9+/]{64,}={0,2}/ },
];

/**
 * Null when the statement looks safe to store.
 *
 * Scan the text the operator or the agent actually offered, before it is
 * trimmed to the store's bound: cutting a long line can take away the very
 * marker — a `-----BEGIN` header, an assignment's value — that gives it away.
 */
export function findSecret(text: string): SecretKind | null {
  if (!text) return null;
  for (const { kind, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return null;
}
