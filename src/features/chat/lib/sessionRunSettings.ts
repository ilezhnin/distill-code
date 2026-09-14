/**
 * The two model-scoped knobs that ride beside a model selection: reasoning
 * effort and fast mode.
 *
 * They are a SIBLING of `SessionExecutionTarget`, never fields on it. Two
 * reasons, both load-bearing:
 *
 * - `withExecutionTarget` returns the SAME session object when identity,
 *   model name and source are unchanged, so an effort-only change written on
 *   the target would be discarded before it was ever stored;
 * - the target is rebuilt field by field in `normalizeSessionExecutionTarget`
 *   and spread through `materializeSessionExecutionModel`, so a field added
 *   there is one careless call site away from being dropped.
 *
 * Keeping the target model-only also means an effort click is not a target
 * change, so it cannot supersede a queued send or reset session state.
 */

/**
 * A harness's own effort value id — "xhigh", "default", "ultra". Never an
 * app-wide enum: each model's stops come from the bridge, per model, and a
 * shared ladder would have to invent a value some harness refuses.
 */
export type EffortValue = string;

/**
 * The operator's INTENT for the two knobs. It survives model switches: a model
 * that cannot honour a value keeps the intent and shows a notice, so the value
 * returns as soon as a capable model is chosen again.
 *
 * The OBSERVED counterpart — what the current model actually offers and is
 * running at — lives in `ChatSession.reasoningEffort` / `ChatSession.fastMode`.
 */
export interface SessionRunSettings {
  effort?: EffortValue;
  fast?: boolean;
}

/** Why the current model is not running at the operator's chosen value. */
export interface SessionRunSettingsNotice {
  kind: "effort" | "fast";
  /** What was asked for, in the harness's own vocabulary ("on"/"off" for fast). */
  wanted: string;
  /** What is in force instead, or null when the model has no such control. */
  actual: string | null;
  /** The model that refused, named the way the picker names it. */
  modelName: string;
}

export function sameSessionRunSettings(
  left: SessionRunSettings | undefined,
  right: SessionRunSettings | undefined,
): boolean {
  return left?.effort === right?.effort && left?.fast === right?.fast;
}

export function sameSessionRunSettingsNotice(
  left: SessionRunSettingsNotice | null | undefined,
  right: SessionRunSettingsNotice | null | undefined,
): boolean {
  if (!left || !right) {
    return !left === !right;
  }
  return (
    left.kind === right.kind &&
    left.wanted === right.wanted &&
    left.actual === right.actual &&
    left.modelName === right.modelName
  );
}

/** Drops an intent record that names nothing, so the store never holds `{}`. */
export function normalizeSessionRunSettings(
  settings: SessionRunSettings | undefined,
): SessionRunSettings | undefined {
  if (!settings) {
    return undefined;
  }
  const effort = settings.effort?.trim();
  const normalized: SessionRunSettings = {
    ...(effort ? { effort } : {}),
    ...(settings.fast !== undefined ? { fast: settings.fast } : {}),
  };
  return normalized.effort === undefined && normalized.fast === undefined
    ? undefined
    : normalized;
}
