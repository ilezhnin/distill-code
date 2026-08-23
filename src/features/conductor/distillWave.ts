/**
 * Strict parser for the conductor's wave plan (decision D1).
 *
 * Wire format — a fenced block in an assistant message:
 *
 * ```distill-wave
 * {"steps":[{"role":"qa","subtask":"...","access":[],"model":"gpt-5"}]}
 * ```
 *
 * The parse is tri-state (decision Q2, strict-parse without fallback):
 * - no fence at all → `{ kind: "none" }`, an ordinary answer, never an error;
 * - a well-formed fence → `{ kind: "plan", ... }`;
 * - anything else → `{ kind: "invalid", reason, detail }` with an enumerated
 *   machine-readable `reason` and an operator-readable `detail`.
 *
 * There is deliberately no regex fallback and no auto-retry: a broken fence
 * spawns nothing and surfaces its reason to the operator.
 */

import { resolveRoleInLayer, workerLayerRoleIds } from "./roleLayers";

/** Fence info-string that carries a wave plan. */
export const WAVE_FENCE_TAG = "distill-wave";

/** Hard cap on steps in one wave (D1, mirrors the paper's 5-step limit). */
export const MAX_WAVE_STEPS = 5;

/**
 * What a step may read from the wave so far.
 * - `[]` — the step sees nothing but its own subtask; it can start immediately.
 * - `"all"` — the step sees the JSON reports of the earlier steps of its wave.
 *
 * Fine-grained access lists (`[0, 2]`) are a non-goal and are rejected.
 */
export type WaveStepAccess = readonly [] | "all";

export interface WaveStep {
  /** Worker-layer role id from `roleCatalog`, normalized to lowercase. */
  role: string;
  /** The instruction for this step. Never a copy of the operator request. */
  subtask: string;
  access: WaveStepAccess;
  /** Explicit per-step model override (D5). Absent means "inherit". */
  model?: string;
}

/** Machine-readable reasons a `distill-wave` fence was rejected. */
export type WaveInvalidReason =
  /** More than one `distill-wave` fence in the message — ambiguous plan. */
  | "multiple-fences"
  /** An opening fence with no closing fence. */
  | "unterminated-fence"
  /** The fence body is not valid JSON. */
  | "malformed-json"
  /** The fence body parsed, but not into a JSON object. */
  | "not-an-object"
  /** `steps` is missing or is not an array. */
  | "steps-not-array"
  /** `steps` is an empty array. */
  | "steps-empty"
  /** More than `MAX_WAVE_STEPS` steps. */
  | "too-many-steps"
  /** A step is not a JSON object. */
  | "step-not-an-object"
  /** A step's `role` is missing or is not a string. */
  | "role-not-a-string"
  /** A step's `role` is not in `roleCatalog`. */
  | "role-unknown"
  /** A step's `role` exists but is not a worker-layer role. */
  | "role-not-worker-layer"
  /** A step's `subtask` is missing or is not a string. */
  | "subtask-not-a-string"
  /** A step's `subtask` is blank. */
  | "subtask-empty"
  /** A step's `access` is neither `[]` nor `"all"`. */
  | "access-invalid"
  /** A step carries `model`, but not as a non-empty string. */
  | "model-not-a-string";

export interface WaveInvalid {
  kind: "invalid";
  reason: WaveInvalidReason;
  /** Operator-readable explanation; safe to render verbatim. */
  detail: string;
  /** Zero-based index of the offending step, when the reason is per-step. */
  stepIndex?: number;
}

export interface WavePlan {
  kind: "plan";
  steps: WaveStep[];
  /** Raw JSON source from inside the fence, trimmed. */
  planText: string;
  /** The message with the wave fence removed, trimmed. May be empty. */
  prose: string;
}

export type DistillWaveParse = { kind: "none" } | WavePlan | WaveInvalid;

/** Result of scanning a message for exactly one fenced block. */
export type FencedBlockScan =
  | { kind: "none" }
  | { kind: "one"; body: string; prose: string }
  | { kind: "multiple"; count: number }
  | { kind: "unterminated" };

const CLOSING_FENCE = /^[ \t]{0,3}```[ \t]*\r?$/m;

function openingFencePattern(tag: string): RegExp {
  return new RegExp(`^[ \\t]{0,3}\`\`\`[ \\t]*${tag}[ \\t]*\\r?$`, "gim");
}

/**
 * Finds the single fenced block tagged `tag` in `text`.
 *
 * Shared with `distillVerdict.ts` so both protocol fences behave identically.
 */
export function scanFencedBlock(text: string, tag: string): FencedBlockScan {
  const pattern = openingFencePattern(tag);
  const openings: Array<{ start: number; end: number }> = [];
  let match = pattern.exec(text);
  while (match) {
    openings.push({ start: match.index, end: match.index + match[0].length });
    match = pattern.exec(text);
  }
  if (openings.length === 0) return { kind: "none" };
  if (openings.length > 1) {
    return { kind: "multiple", count: openings.length };
  }

  const [opening] = openings;
  const rest = text.slice(opening.end);
  const closing = CLOSING_FENCE.exec(rest);
  if (!closing) return { kind: "unterminated" };

  const body = rest.slice(0, closing.index);
  const blockEnd = opening.end + closing.index + closing[0].length;
  const before = text.slice(0, opening.start).trim();
  const after = text.slice(blockEnd).trim();
  const prose = before && after ? `${before}\n\n${after}` : before || after;
  return { kind: "one", body: body.trim(), prose };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(
  reason: WaveInvalidReason,
  detail: string,
  stepIndex?: number,
): WaveInvalid {
  return stepIndex === undefined
    ? { kind: "invalid", reason, detail }
    : { kind: "invalid", reason, detail, stepIndex };
}

function parseAccess(raw: unknown): WaveStepAccess | undefined {
  if (raw === "all") return "all";
  if (Array.isArray(raw) && raw.length === 0) return [];
  return undefined;
}

/**
 * Validates one already-parsed step object.
 *
 * Exported so the few-shot example validator can check a step without going
 * through a whole message.
 */
export function parseWaveStep(
  raw: unknown,
  stepIndex: number,
): WaveStep | WaveInvalid {
  if (!isJsonObject(raw)) {
    return invalid(
      "step-not-an-object",
      `Step ${stepIndex + 1} is not a JSON object.`,
      stepIndex,
    );
  }

  if (typeof raw.role !== "string" || !raw.role.trim()) {
    return invalid(
      "role-not-a-string",
      `Step ${stepIndex + 1} needs a "role" string.`,
      stepIndex,
    );
  }
  const roleCheck = resolveRoleInLayer(raw.role, "worker");
  if (!roleCheck.ok) {
    return invalid(
      roleCheck.issue === "role-unknown"
        ? "role-unknown"
        : "role-not-worker-layer",
      `Step ${stepIndex + 1}: ${roleCheck.detail}`,
      stepIndex,
    );
  }

  if (typeof raw.subtask !== "string") {
    return invalid(
      "subtask-not-a-string",
      `Step ${stepIndex + 1} needs a "subtask" string.`,
      stepIndex,
    );
  }
  const subtask = raw.subtask.trim();
  if (!subtask) {
    return invalid(
      "subtask-empty",
      `Step ${stepIndex + 1} has an empty "subtask".`,
      stepIndex,
    );
  }

  const access = parseAccess(raw.access);
  if (access === undefined) {
    return invalid(
      "access-invalid",
      `Step ${stepIndex + 1} needs "access": [] (sees nothing) or "all" (sees earlier reports). Fine-grained access lists are not supported.`,
      stepIndex,
    );
  }

  const step: WaveStep = { role: roleCheck.role.id, subtask, access };

  if ("model" in raw && raw.model !== undefined) {
    if (typeof raw.model !== "string" || !raw.model.trim()) {
      return invalid(
        "model-not-a-string",
        `Step ${stepIndex + 1}: "model" must be a non-empty string when present.`,
        stepIndex,
      );
    }
    step.model = raw.model.trim();
  }

  return step;
}

function isInvalid(value: WaveStep | WaveInvalid): value is WaveInvalid {
  return "kind" in value && value.kind === "invalid";
}

/**
 * Parses the JSON body of a `distill-wave` fence (without the fence itself).
 *
 * Exported for the few-shot example validator, which stores plan bodies rather
 * than whole messages.
 */
export function parseWavePlanBody(
  body: string,
): { kind: "plan"; steps: WaveStep[] } | WaveInvalid {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // V8 phrases an unescaped quote inside a string value as this complaint;
    // long free-text subtasks make it the most likely malformed-json cause by
    // far, so the detail names it instead of leaving a bare byte position.
    const hint = /Expected ',' or '}' after property value/.test(message)
      ? " A common cause is a raw double-quote inside a string value, such as a subtask that quotes something."
      : "";
    return invalid(
      "malformed-json",
      `The ${WAVE_FENCE_TAG} block is not valid JSON: ${message}.${hint}`,
    );
  }

  if (!isJsonObject(parsed)) {
    return invalid(
      "not-an-object",
      `The ${WAVE_FENCE_TAG} block must contain a JSON object with a "steps" array.`,
    );
  }
  if (!Array.isArray(parsed.steps)) {
    return invalid("steps-not-array", `"steps" must be an array.`);
  }
  if (parsed.steps.length === 0) {
    return invalid(
      "steps-empty",
      `"steps" is empty. Answer directly instead of planning an empty wave.`,
    );
  }
  if (parsed.steps.length > MAX_WAVE_STEPS) {
    return invalid(
      "too-many-steps",
      `A wave takes at most ${MAX_WAVE_STEPS} steps, got ${parsed.steps.length}.`,
    );
  }

  const steps: WaveStep[] = [];
  for (const [index, rawStep] of parsed.steps.entries()) {
    const step = parseWaveStep(rawStep, index);
    if (isInvalid(step)) return step;
    steps.push(step);
  }

  return { kind: "plan", steps };
}

/**
 * Tri-state parse of an assistant message from the conductor.
 *
 * No `distill-wave` fence is not an error — it means the conductor answered
 * the operator directly (the D3 complexity gate).
 */
export function parseDistillWave(messageText: string): DistillWaveParse {
  const scan = scanFencedBlock(messageText, WAVE_FENCE_TAG);
  if (scan.kind === "none") return { kind: "none" };
  if (scan.kind === "multiple") {
    return invalid(
      "multiple-fences",
      `Found ${scan.count} ${WAVE_FENCE_TAG} blocks. Send exactly one plan per message.`,
    );
  }
  if (scan.kind === "unterminated") {
    return invalid(
      "unterminated-fence",
      `The ${WAVE_FENCE_TAG} block was opened but never closed.`,
    );
  }

  const body = parseWavePlanBody(scan.body);
  if (body.kind === "invalid") return body;
  return {
    kind: "plan",
    steps: body.steps,
    planText: scan.body,
    prose: scan.prose,
  };
}

/** Every worker-layer role id a wave step may name. */
export function allowedWaveRoleIds(): readonly string[] {
  return workerLayerRoleIds();
}
