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
  "label-not-a-string": "labelNotAString",
  "label-too-long": "labelTooLong",
  "model-not-a-string": "modelNotAString",
  "step-model-unavailable": "stepModelUnavailable",
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

/**
 * The notice posted when the spawn ACL refuses a programmatic spawn (D5:
 * every refusal is visible, and it names the facts — who asked, on which
 * layer it runs, which layer it asked for, and what it is actually allowed
 * to start). Posted by the spawn chokepoint itself, so no path can refuse
 * silently.
 */
export function spawnAclDeniedNoticeText(facts: {
  initiatorName: string;
  initiatorLayer: string;
  targetLayer: string;
  allowedLayers: readonly string[];
}): string {
  return [
    i18n.t("chat:conductor.spawnAcl.deniedTitle"),
    i18n.t("chat:conductor.spawnAcl.deniedBody", {
      initiator: facts.initiatorName,
      initiatorLayer: facts.initiatorLayer,
      targetLayer: facts.targetLayer,
    }),
    facts.allowedLayers.length > 0
      ? i18n.t("chat:conductor.spawnAcl.allowedLayers", {
          layers: facts.allowedLayers.join(", "),
        })
      : i18n.t("chat:conductor.spawnAcl.allowedNone"),
  ].join("\n\n");
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
  "accepted-with-missing-artifacts": "acceptedWithMissingArtifacts",
  "wave-interrupted": "waveInterrupted",
  "operator-stopped": "operatorStopped",
  "step-blocked": "stepBlocked",
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
export function waveConcurrentPlanNoticeText(refusedCount = 1): string {
  const lines = [
    i18n.t("chat:conductor.wave.concurrent.title"),
    i18n.t("chat:conductor.wave.concurrent.body"),
  ];
  // One card per wave, not per refused plan: the rule is the same every time,
  // and a drained message queue can turn "say it once per plan" into seven
  // identical walls of text in a row. The count is what actually differs, and
  // it is the part the operator needs — without it they cannot tell how many
  // of their requests were dropped while the wave ran.
  if (refusedCount > 1) {
    lines.push(
      i18n.t("chat:conductor.wave.concurrent.refusedCount", {
        count: refusedCount,
      }),
    );
  }
  return lines.join("\n\n");
}

/**
 * The notice posted the first time the browser refuses to persist state.
 *
 * The stores swallow the error so a quota failure cannot take a running wave
 * with it, which leaves the worst possible surface: the app keeps rendering
 * the live wave from memory and looks entirely healthy, while the next
 * restart comes up with nothing and no explanation. Said once — a full origin
 * refuses every write, and one warning per refused write would bury the
 * transcript it is trying to warn in.
 */
export function persistFailureNoticeText(facts: {
  failures: number;
  reason?: string;
}): string {
  const lines = [
    i18n.t("chat:conductor.persist.title"),
    i18n.t("chat:conductor.persist.body", { count: facts.failures }),
  ];
  if (facts.reason) {
    lines.push(
      i18n.t("chat:conductor.persist.reason", { reason: facts.reason }),
    );
  }
  return lines.join("\n\n");
}

/**
 * The notice posted when a fresh plan follows a request that spent its cap.
 *
 * The cap is counted per *plan message*, not per conversation, so any word
 * the operator says after `needsOperator` silently restores the full budget
 * of two revisions. That mechanic is right — it is human-gated, and the
 * operator asking again is the gate — but it is invisible, and an invisible
 * budget reset is how a request quietly costs six waves instead of three.
 *
 * So the machinery is untouched and only the fact is said, once, on the plan
 * that resets it.
 */
export function waveRevisionBudgetResetNoticeText(): string {
  return [
    i18n.t("chat:conductor.wave.budgetReset.title"),
    i18n.t("chat:conductor.wave.budgetReset.body", { max: MAX_WAVE_REVISIONS }),
  ].join("\n\n");
}

/**
 * The notice posted when a wave step runs on something other than the first
 * model its role ranked.
 *
 * D5 again: the ranking exists so the operator does not have to babysit which
 * model is free, and the price of that is saying when the choice moved. It is
 * a warning rather than an error — a fallback is the ranking working, not
 * failing — and it is said once per spawn, where the wave is already watched.
 */
export function waveStepModelNoticeText(facts: {
  stepIndex: number;
  name: string;
  model: string;
  nearLimit: boolean;
}): string {
  return i18n.t(
    facts.nearLimit
      ? "chat:conductor.wave.stepModel.nearLimit"
      : "chat:conductor.wave.stepModel.fallback",
    {
      step: facts.stepIndex + 1,
      name: facts.name,
      model: facts.model,
    },
  );
}

/**
 * The notice posted when a plan pins a step to a model the operator ranked
 * below the one it would have inherited (P12).
 *
 * A warning, not a refusal: 4a made the field legal, and the conductor may
 * have a reason the ranking does not know. What it must not do is happen
 * quietly — a small model under a JSON format constraint is where this whole
 * protocol loses the most, and that trade belongs in front of the operator
 * while the wave is still worth stopping. Both models are named, because
 * "ranked lower" means nothing without the pair.
 */
export function waveStepModelDowngradeNoticeText(facts: {
  stepIndex: number;
  name: string;
  stepModel: string;
  inheritedModel: string;
}): string {
  return i18n.t("chat:conductor.wave.stepModel.downgrade", {
    step: facts.stepIndex + 1,
    name: facts.name,
    model: facts.stepModel,
    inherited: facts.inheritedModel,
  });
}

/**
 * The notice posted when a step runs on the model the plan explicitly named
 * while that model's usage window is nearly or fully spent.
 *
 * Only the limit is news here: the model itself is already visible on the
 * step's chip and the child tab, and admission refused an at-limit model
 * while there was still time to replan. This covers the window that filled up
 * between admission and a late spawn — the instruction is honoured, and the
 * operator is told the step may be cut off rather than being surprised by it.
 */
export function waveStepExplicitModelNoticeText(facts: {
  stepIndex: number;
  name: string;
  model: string;
}): string {
  return i18n.t("chat:conductor.wave.stepModel.explicitNearLimit", {
    step: facts.stepIndex + 1,
    name: facts.name,
    model: facts.model,
  });
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

/**
 * The notice posted when a worker's blocked report stops its wave (§5 risk 9).
 *
 * Same anatomy as {@link waveClosureNoticeText} — the loop-stopped title, one
 * line saying what happened and what it cost, and then the worker's own
 * reason, attributed as the worker's so it is never read as the app's
 * verdict on anything. It is a warning, not an error, for the same reason
 * the operator's stop is: nothing malfunctioned — a worker said honestly
 * that its step cannot be done, and the app took the cheapest exit.
 */
export function waveStepBlockedNoticeText(facts: {
  stepIndex: number;
  name: string;
  reason?: string;
}): string {
  const lines = [
    i18n.t("chat:conductor.wave.verdict.needsOperatorTitle"),
    i18n.t("chat:conductor.wave.stepBlocked", {
      step: facts.stepIndex + 1,
      name: facts.name,
    }),
  ];
  const reason = facts.reason?.trim();
  if (reason) {
    lines.push(i18n.t("chat:conductor.wave.stepBlockedReason", { reason }));
  }
  return lines.join("\n\n");
}

/**
 * Warning posted the moment a step goes terminal on the "result unknown"
 * stub (5b). Once per step — the engine's persisted `reportDegraded` flag is
 * the idempotency; this is only the wording.
 *
 * It names the step AND the consequence, because "finished without a report"
 * alone sounds like an accounting detail: the digest the conductor will judge,
 * and every later step's handoff, now contain a stub where that worker's
 * account should have been. The stop control next to the wait indicator is
 * the operator's lever if that is not acceptable.
 */
export function waveReportDegradedNoticeText(
  stepIndex: number,
  name: string,
): string {
  return i18n.t("chat:conductor.wave.reportDegraded", {
    step: stepIndex + 1,
    name,
  });
}
