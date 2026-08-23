/**
 * Strict parser for the conductor's post-digest verdict (decision D4).
 *
 * **This module fixes the verdict tokens once.** The wave engine (2a/3a), the
 * conductor protocol prompt, and the operator skills all reuse the constants
 * exported here — no other spelling of a verdict is legal anywhere.
 *
 * Wire format — a fenced block in an assistant message:
 *
 * ```distill-verdict
 * {"verdict":"accept","note":"Both steps landed."}
 * ```
 *
 * Three outcomes (D4): `accept`, `revise` (exactly one revision wave), and
 * `needs-operator`. A revision wave is a `distill-wave` fence in the same
 * message, parsed by `distillWave.ts`; a bare wave fence with no verdict fence
 * is read as `revise` as well.
 *
 * The parse is tri-state and there is no auto-retry (decision Q5): the caller
 * turns `none` and `invalid` into `needs-operator` plus a manual retry button.
 */

import {
  type DistillWaveParse,
  type WaveInvalidReason,
  WAVE_FENCE_TAG,
  type WaveStep,
  parseDistillWave,
  scanFencedBlock,
} from "./distillWave";

/** Fence info-string that carries a verdict. */
export const VERDICT_FENCE_TAG = "distill-verdict";

/**
 * The verdict vocabulary. Fixed here once — code, prompts and skills all read
 * these constants instead of spelling the tokens again.
 */
export const VERDICT_TOKENS = {
  accept: "accept",
  revise: "revise",
  needsOperator: "needs-operator",
} as const;

export type VerdictToken = (typeof VERDICT_TOKENS)[keyof typeof VERDICT_TOKENS];

export const VERDICT_TOKEN_VALUES: readonly VerdictToken[] = [
  VERDICT_TOKENS.accept,
  VERDICT_TOKENS.revise,
  VERDICT_TOKENS.needsOperator,
];

export type Verdict =
  /** The wave's result answers the operator; nothing more is dispatched. */
  | { outcome: "accept"; note?: string }
  /** Exactly one revision wave; the caller enforces the cap of 2 (D4). */
  | { outcome: "revise"; steps: WaveStep[]; note?: string }
  /** The conductor hands the root request back to the operator. */
  | { outcome: "needs-operator"; note?: string };

/** Machine-readable reasons a verdict message was rejected. */
export type VerdictInvalidReason =
  /** More than one `distill-verdict` fence in the message. */
  | "multiple-fences"
  /** An opening verdict fence with no closing fence. */
  | "unterminated-fence"
  /** The fence body is not valid JSON. */
  | "malformed-json"
  /** The fence body parsed, but not into a JSON object. */
  | "not-an-object"
  /** `verdict` is missing or is not a string. */
  | "verdict-not-a-string"
  /** `verdict` is a string, but not one of the three tokens. */
  | "verdict-unknown"
  /** `note` is present but is not a string. */
  | "note-not-a-string"
  /** Verdict `revise`, but the message carries no `distill-wave` fence. */
  | "revision-wave-missing"
  /** Verdict `revise`, and the `distill-wave` fence failed to parse. */
  | "revision-wave-invalid"
  /** Verdict `accept` or `needs-operator` shipped with a `distill-wave` fence. */
  | "unexpected-revision-wave";

export interface VerdictInvalid {
  kind: "invalid";
  reason: VerdictInvalidReason;
  /** Operator-readable explanation; safe to render verbatim. */
  detail: string;
  /** Underlying wave reason when `reason` is `revision-wave-invalid`. */
  waveReason?: WaveInvalidReason;
}

export interface VerdictParsed {
  kind: "verdict";
  verdict: Verdict;
  /** The message with the verdict (and revision wave) fences removed. */
  prose: string;
}

export type DistillVerdictParse =
  | { kind: "none" }
  | VerdictParsed
  | VerdictInvalid;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(
  reason: VerdictInvalidReason,
  detail: string,
  waveReason?: WaveInvalidReason,
): VerdictInvalid {
  return waveReason === undefined
    ? { kind: "invalid", reason, detail }
    : { kind: "invalid", reason, detail, waveReason };
}

function isVerdictToken(value: string): value is VerdictToken {
  return (VERDICT_TOKEN_VALUES as readonly string[]).includes(value);
}

function readNote(raw: Record<string, unknown>): string | VerdictInvalid {
  if (raw.note === undefined || raw.note === null) return "";
  if (typeof raw.note !== "string") {
    return invalid(
      "note-not-a-string",
      `"note" must be a string when present.`,
    );
  }
  return raw.note.trim();
}

function withNote<T extends Verdict>(verdict: T, note: string): T {
  return note ? { ...verdict, note } : verdict;
}

/**
 * Tri-state parse of the conductor's answer to a wave digest.
 *
 * `{ kind: "none" }` means the conductor replied with neither a verdict fence
 * nor a wave fence — per Q5 the caller treats that as `needs-operator`, but the
 * parser reports it honestly rather than inventing an outcome.
 */
export function parseDistillVerdict(messageText: string): DistillVerdictParse {
  const scan = scanFencedBlock(messageText, VERDICT_FENCE_TAG);
  if (scan.kind === "multiple") {
    return invalid(
      "multiple-fences",
      `Found ${scan.count} ${VERDICT_FENCE_TAG} blocks. Send exactly one verdict per message.`,
    );
  }
  if (scan.kind === "unterminated") {
    return invalid(
      "unterminated-fence",
      `The ${VERDICT_FENCE_TAG} block was opened but never closed.`,
    );
  }

  const wave = parseDistillWave(messageText);

  if (scan.kind === "none") {
    return parseBareWaveAsRevision(wave, messageText);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(scan.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return invalid(
      "malformed-json",
      `The ${VERDICT_FENCE_TAG} block is not valid JSON: ${message}`,
    );
  }
  if (!isJsonObject(parsed)) {
    return invalid(
      "not-an-object",
      `The ${VERDICT_FENCE_TAG} block must contain a JSON object with a "verdict" field.`,
    );
  }
  if (typeof parsed.verdict !== "string") {
    return invalid(
      "verdict-not-a-string",
      `The ${VERDICT_FENCE_TAG} block needs a "verdict" string: ${VERDICT_TOKEN_VALUES.join(" | ")}.`,
    );
  }
  const token = parsed.verdict.trim();
  if (!isVerdictToken(token)) {
    return invalid(
      "verdict-unknown",
      `Unknown verdict "${parsed.verdict}". Use one of: ${VERDICT_TOKEN_VALUES.join(" | ")}.`,
    );
  }
  const note = readNote(parsed);
  if (typeof note !== "string") return note;

  if (token !== VERDICT_TOKENS.revise) {
    if (wave.kind !== "none") {
      return invalid(
        "unexpected-revision-wave",
        `Verdict "${token}" cannot carry a ${WAVE_FENCE_TAG} block. Use "${VERDICT_TOKENS.revise}" to run another wave.`,
      );
    }
    return {
      kind: "verdict",
      verdict: withNote(
        token === VERDICT_TOKENS.accept
          ? { outcome: "accept" }
          : { outcome: "needs-operator" },
        note,
      ),
      prose: scan.prose,
    };
  }

  if (wave.kind === "none") {
    return invalid(
      "revision-wave-missing",
      `Verdict "${VERDICT_TOKENS.revise}" needs a ${WAVE_FENCE_TAG} block with the revision wave in the same message.`,
    );
  }
  if (wave.kind === "invalid") {
    return invalid(
      "revision-wave-invalid",
      `The revision wave was rejected: ${wave.detail}`,
      wave.reason,
    );
  }
  return {
    kind: "verdict",
    verdict: withNote({ outcome: "revise", steps: wave.steps }, note),
    prose: proseWithoutWave(scan.prose, wave),
  };
}

function parseBareWaveAsRevision(
  wave: DistillWaveParse,
  messageText: string,
): DistillVerdictParse {
  if (wave.kind === "none") return { kind: "none" };
  if (wave.kind === "invalid") {
    return invalid(
      "revision-wave-invalid",
      `The revision wave was rejected: ${wave.detail}`,
      wave.reason,
    );
  }
  return {
    kind: "verdict",
    verdict: { outcome: "revise", steps: wave.steps },
    prose: wave.prose || messageText.trim(),
  };
}

function proseWithoutWave(prose: string, wave: DistillWaveParse): string {
  if (wave.kind !== "plan") return prose;
  const stripped = parseDistillWave(prose);
  return stripped.kind === "plan" ? stripped.prose : prose;
}
