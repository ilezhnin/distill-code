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
import {
  MAX_WAVE_REVISIONS,
  type WaveClosure,
  type WaveClosureReason,
} from "./waveVerdict";

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
  "verification-step-missing": "verificationStepMissing",
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

/** i18n key (inside `chat:conductor.wave.verdict.reason`) per closure code. */
export const WAVE_CLOSURE_REASON_KEYS: Record<WaveClosureReason, string> = {
  accepted: "accepted",
  "conductor-needs-operator": "conductorNeedsOperator",
  "verdict-missing": "verdictMissing",
  "verdict-invalid": "verdictInvalid",
  "revision-cap-reached": "revisionCapReached",
  "digest-undeliverable": "digestUndeliverable",
  "accepted-without-evidence": "acceptedWithoutEvidence",
  "wave-interrupted": "waveInterrupted",
};

/**
 * The notice posted when a wave stops at `needsOperator`.
 *
 * One line saying the loop stopped, one line saying why, and — when the
 * conductor supplied one — its own note. The parser's `detail` is appended
 * last, same discipline as {@link waveRejectionNoticeText}: the localized line
 * explains the consequence, the detail explains the syntax.
 */
export function waveClosureNoticeText(closure: WaveClosure): string {
  const reasonKey = WAVE_CLOSURE_REASON_KEYS[closure.reason];
  const lines = [
    i18n.t("chat:conductor.wave.verdict.needsOperatorTitle"),
    i18n.t(`chat:conductor.wave.verdict.reason.${reasonKey}`, {
      max: MAX_WAVE_REVISIONS,
    }),
  ];
  const note = closure.note?.trim();
  if (note) lines.push(i18n.t("chat:conductor.wave.verdict.note", { note }));
  const detail = closure.detail?.trim();
  if (detail) lines.push(detail);
  return lines.join("\n\n");
}

/**
 * The notice posted when a conductor plans a second wave while its first one
 * is still live (§4.1).
 *
 * It is not an error the conductor made — the operator asking for one more
 * thing mid-run is the most natural thing in the world — so it says what
 * happened, that nothing was spawned, and what to do instead: wait for the
 * wave to close, or ask the running wave for a status.
 */
export function waveConcurrentPlanNoticeText(): string {
  return [
    i18n.t("chat:conductor.wave.concurrent.title"),
    i18n.t("chat:conductor.wave.concurrent.body"),
  ].join("\n\n");
}

/** Label of the manual verdict re-ask (Q5). There is no auto-retry. */
export function waveVerdictRetryLabel(): string {
  return i18n.t("chat:conductor.wave.verdict.retry");
}

/**
 * Stand-in prose for a verdict message that carried nothing but its fence.
 *
 * The fence is machine-facing and is stripped before the transcript is
 * rendered; a message whose whole body was the fence would otherwise vanish.
 */
export function waveVerdictProseFallback(
  outcome: "accept" | "revise" | "needs-operator",
): string {
  const key =
    outcome === "accept"
      ? "accept"
      : outcome === "revise"
        ? "revise"
        : "needsOperator";
  return i18n.t(`chat:conductor.wave.verdict.prose.${key}`);
}

/**
 * Notice posted in the parent when a digest could not be delivered at all.
 *
 * It carries the digest text verbatim: the children's reports are already
 * flagged published by then, so this notice is the only surviving copy of what
 * they said, and swallowing it would lose the run.
 */
export function digestDeliveryFailureText(
  reason: string,
  digest: string,
): string {
  return [
    i18n.t("chat:conductor.wave.digest.deliveryFailed"),
    reason.trim(),
    digest.trim(),
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
}

/**
 * The Q6 badge text. Lives with the other operator-facing conductor strings so
 * there is one place that owns what the operator reads about a wave.
 */
export function conductorSelfExecutionBadgeText(): string {
  return i18n.t("chat:conductor.selfExecutingBadge");
}
