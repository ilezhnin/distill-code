/**
 * Operator-facing text for a refused wave plan.
 *
 * The engine speaks in enumerated `WaveRejectionReason` codes; this module is
 * the single place that turns a code into a sentence the operator reads. The
 * parser's `detail` is appended, never used as the whole message: `detail`
 * explains the syntax, the localized line explains what it means for the run.
 */

import { i18n } from "@/shared/i18n";

import type { WaveRejectionReason } from "./waveEngine";

/** i18n key (inside `chat:conductor.wave.reason`) for every rejection code. */
export const WAVE_REJECTION_REASON_KEYS: Record<WaveRejectionReason, string> = {
  "multiple-fences": "multipleFences",
  "unterminated-fence": "unterminatedFence",
  "malformed-json": "malformedJson",
  "not-an-object": "notAnObject",
  "steps-not-array": "stepsNotArray",
  "steps-empty": "stepsEmpty",
  "too-many-steps": "tooManySteps",
  "step-not-an-object": "stepNotAnObject",
  "role-not-a-string": "roleNotAString",
  "role-unknown": "roleUnknown",
  "role-not-worker-layer": "roleNotWorkerLayer",
  "subtask-not-a-string": "subtaskNotAString",
  "subtask-empty": "subtaskEmpty",
  "access-invalid": "accessInvalid",
  "model-not-a-string": "modelNotAString",
  "step-model-unsupported": "stepModelUnsupported",
};

export interface WaveRejectionNotice {
  reason: WaveRejectionReason;
  detail: string;
  stepIndex?: number;
}

/**
 * The full notice body: a title line, the localized reason, and the parser's
 * detail. Rendered verbatim into the conductor transcript.
 */
export function waveRejectionNoticeText(notice: WaveRejectionNotice): string {
  const reasonKey = WAVE_REJECTION_REASON_KEYS[notice.reason];
  const reason = i18n.t(`chat:conductor.wave.reason.${reasonKey}`, {
    step: (notice.stepIndex ?? 0) + 1,
  });
  const lines = [i18n.t("chat:conductor.wave.invalidTitle"), reason];
  const detail = notice.detail.trim();
  if (detail && detail !== reason) lines.push(detail);
  return lines.join("\n\n");
}

/** Label of the manual retry affordance. There is no auto-retry (Q2). */
export function waveRetryLabel(): string {
  return i18n.t("chat:conductor.wave.retry");
}

/** Notice shown when a wave step could not be started at all. */
export function waveSpawnFailureText(
  stepIndex: number,
  detail: string,
): string {
  const lines = [
    i18n.t("chat:conductor.wave.spawnFailed", { step: stepIndex + 1 }),
  ];
  const trimmed = detail.trim();
  if (trimmed) lines.push(trimmed);
  return lines.join("\n\n");
}
