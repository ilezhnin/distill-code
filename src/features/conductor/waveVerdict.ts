/**
 * The wave's closed loop, as pure decisions (D4).
 *
 * `waveEngine.ts` decides what a *running* wave does with its steps. This
 * module decides what happens after the last step is terminal:
 *
 * ```text
 *   running → digestPending → dispatchingDigest → awaitingVerdict
 *                                                      ├─ accept (checked)   → accepted
 *                                                      ├─ accept (unchecked) → needsOperator (E2)
 *                                                      ├─ revise (cap ok)    → revised + one new wave
 *                                                      ├─ revise (capped)    → needsOperator
 *                                                      ├─ needs-operator     → needsOperator
 *                                                      └─ none / invalid     → needsOperator (Q5)
 * ```
 *
 * Nothing here reads a store, sends a message, or spawns a session; the shell
 * that does is `waveLifecycle.ts`. Keeping the decision pure is what makes the
 * cap, the fail-safe and the restart behaviour testable at all — the effects
 * around them are barely more than plumbing.
 *
 * Two rules are load-bearing and easy to lose:
 *
 * - **The cap is counted in the app, never in the prompt (D4).** It rides on
 *   the persisted wave as `revisionCount`, inherited by each revision, so it
 *   survives a restart and a conductor that forgets it was told.
 * - **A verdict that cannot be read is not retried automatically (Q5).** It
 *   goes straight to `needsOperator` *without* spending a revision, and the
 *   operator gets a button.
 * - **`accept` on a checkable wave is honoured only on the verification
 *   step's evidence (E2).** The protocol prompt says so; this is where the
 *   sentence becomes a decision the code can make, because a model asked to
 *   judge its own workers' accounts of themselves is the failure mode the
 *   whole loop exists inside. It checks that *something was inspected*, never
 *   whether the work is good — that judgement is still the conductor's, and
 *   nothing here makes it a better one.
 */

import type { DistillVerdictParse } from "./distillVerdict";
import type { WaveStep } from "./distillWave";
import type { StructuredReport } from "./types";
import {
  waveRequiresVerification,
  waveVerificationStep,
  type WavePhase,
  type WaveState,
  type WaveVerdictIssue,
} from "./waveEngine";

/** Hard cap on revision waves per root operator request (D4). */
export const MAX_WAVE_REVISIONS = 2;

/** Why a wave left the loop. One code per operator-visible outcome. */
export type WaveClosureReason =
  /** The conductor accepted the result; its prose is the answer. */
  | "accepted"
  /** The conductor asked for the operator itself. */
  | "conductor-needs-operator"
  /** The conductor answered, but with no verdict fence at all (Q5). */
  | "verdict-missing"
  /** The conductor answered with a verdict fence that did not parse (Q5). */
  | "verdict-invalid"
  /** A revision was asked for after the cap was already spent. */
  | "revision-cap-reached"
  /** The digest could not be delivered to the conductor at all. */
  | "digest-undeliverable"
  /**
   * The conductor accepted a checkable wave whose verification step produced
   * no evidence — it failed, it was never run, or it reported no artifacts
   * (E2). The prompt has said "accept only on the verifier's evidence" since
   * `81b29ef`; this is where that sentence becomes a decision.
   */
  | "accepted-without-evidence"
  /**
   * The conductor accepted a wave whose reports named files that are not on
   * disk (E3b). E2 asks whether a claim of verification was made; this asks
   * whether it was true, and it is the only check in the loop a model cannot
   * satisfy by writing something plausible. The conductor may still be right
   * about the work — so this parks rather than fails — but nothing closes on
   * a report that named a file which does not exist.
   */
  | "accepted-with-missing-artifacts"
  /**
   * Every step went terminal without a single report: the run was interrupted
   * (C3), not finished. Digesting it would spend a model call judging "unknown"
   * for every step.
   */
  | "wave-interrupted"
  /**
   * The operator pressed the stop control on a running wave (5b). Its
   * executors were told to stop and nothing was digested or judged — the
   * operator chose to cut the loop, and the loop obeyed.
   */
  | "operator-stopped"
  /**
   * A worker reported its step `blocked` — it could not be done at all — and
   * the app stopped the wave through the same path as the operator's stop
   * (§5 risk 9): remaining steps were not started, running executors were
   * told to stop, and nothing was digested or judged. Replanning is the
   * operator's move (Q2 — no auto-retry), which the conductor learns of the
   * same way it does after 5b: from the operator's next message, with the
   * parked wave swept by the next admitted plan.
   */
  | "step-blocked";

export interface WaveClosure {
  reason: WaveClosureReason;
  /** The conductor's own note, when it supplied one. */
  note?: string;
  /** Machine detail (parser message, dispatch error). Safe to render. */
  detail?: string;
}

export interface WaveRevisionRequest {
  steps: readonly WaveStep[];
  /** 1-based index of this revision within its root request. */
  revisionIndex: number;
}

export interface WaveVerdictDecision {
  /** The phase the judged wave moves to. */
  phase: WavePhase;
  /** Set on every phase except `revised`'s successor bookkeeping. */
  closure?: WaveClosure;
  /** Set only when a revision wave must be created now. */
  revision?: WaveRevisionRequest;
  /**
   * True when the operator is offered a manual re-ask (Q5). Only an unreadable
   * verdict gets one: a conductor that deliberately said `needs-operator`, or a
   * request that exhausted its cap, would answer a retry the same way.
   */
  offerRetry: boolean;
  /**
   * What was wrong with the answer, when it could not be read as a verdict.
   * Rides on the wave so the operator's retry re-asks in terms the conductor
   * can correct instead of repeating the same question (Q5).
   */
  verdictIssue?: WaveVerdictIssue;
}

/**
 * Reads the conductor's answer to a digest and says what the wave does next.
 *
 * `revisionCount` is how many revisions the *root request* has already spent —
 * `wave.revisionCount` of the wave being judged, which every revision inherits
 * incremented.
 */
export function decideWaveVerdict(input: {
  parse: DistillVerdictParse;
  revisionCount: number;
  maxRevisions?: number;
  /** The wave being judged. Read only for the E2 evidence gate. */
  wave: WaveState;
  /** Report lookup by run id. The shell owns the store; this stays pure. */
  reportOf: (runId: string | null | undefined) => StructuredReport | undefined;
}): WaveVerdictDecision {
  const maxRevisions = input.maxRevisions ?? MAX_WAVE_REVISIONS;
  const { parse } = input;

  if (parse.kind === "none") {
    return {
      phase: "needsOperator",
      closure: { reason: "verdict-missing" },
      offerRetry: true,
      verdictIssue: { reason: "missing" },
    };
  }
  if (parse.kind === "invalid") {
    return {
      phase: "needsOperator",
      closure: { reason: "verdict-invalid", detail: parse.detail },
      offerRetry: true,
      verdictIssue: { reason: "invalid", detail: parse.detail },
    };
  }

  const { verdict } = parse;
  if (verdict.outcome === "accept") {
    // Order matters: "nobody checked" is a bigger fact than "what was
    // checked does not exist", and reporting the smaller one first would let
    // an unverified wave be explained away by a passing path check.
    const missing = missingVerificationEvidence(input.wave, input.reportOf);
    if (missing) {
      // Not a retry: asking the same conductor again produces the same accept.
      // This is the operator's to look at.
      return {
        phase: "needsOperator",
        closure: {
          reason: "accepted-without-evidence",
          detail: missing,
          ...(verdict.note ? { note: verdict.note } : {}),
        },
        offerRetry: false,
      };
    }
    const absent = input.wave.missingArtifacts ?? [];
    if (absent.length > 0) {
      // Not a retry, for the same reason as E2: the same conductor asked the
      // same question answers it the same way. The files are the operator's.
      return {
        phase: "needsOperator",
        closure: {
          reason: "accepted-with-missing-artifacts",
          detail: missingArtifactsDetail(absent),
          ...(verdict.note ? { note: verdict.note } : {}),
        },
        offerRetry: false,
      };
    }
    return {
      phase: "accepted",
      closure: {
        reason: "accepted",
        ...(verdict.note ? { note: verdict.note } : {}),
      },
      offerRetry: false,
    };
  }
  if (verdict.outcome === "needs-operator") {
    return {
      phase: "needsOperator",
      closure: {
        reason: "conductor-needs-operator",
        ...(verdict.note ? { note: verdict.note } : {}),
      },
      offerRetry: false,
    };
  }

  if (input.revisionCount >= maxRevisions) {
    return {
      phase: "needsOperator",
      closure: {
        reason: "revision-cap-reached",
        ...(verdict.note ? { note: verdict.note } : {}),
      },
      offerRetry: false,
    };
  }

  // No closure: a revision posts nothing to the operator. The conductor's own
  // prose (and the revision wave's chips) are already in the transcript.
  return {
    phase: "revised",
    revision: {
      steps: verdict.steps,
      revisionIndex: input.revisionCount + 1,
    },
    offerRetry: false,
  };
}

/**
 * The paths, named as the workers wrote them, so the operator can go look.
 *
 * Capped: a report that named forty absent files has a different problem than
 * one that named two, and the count says that better than forty lines would.
 */
function missingArtifactsDetail(missing: readonly string[]): string {
  const shown = missing.slice(0, 5);
  const rest = missing.length - shown.length;
  const list = shown.map((path) => `"${path}"`).join(", ");
  const tail = rest > 0 ? `, and ${rest} more` : "";
  return `The reports named ${missing.length === 1 ? "a file that is not" : "files that are not"} on disk: ${list}${tail}.`;
}

/**
 * Why a checkable wave's `accept` is not backed by evidence, or `null` when it
 * is (or when the wave was never checkable in the first place).
 *
 * Three distinct failures collapse to one answer, deliberately: no closing
 * verification step at all (a wave admitted before the E1 lint existed, or a
 * revision the conductor reshaped), a verification step that did not complete,
 * and a verification step that completed while producing nothing. All three
 * mean the same thing to the operator — nobody looked at the artifact.
 */
function missingVerificationEvidence(
  wave: WaveState,
  reportOf: (runId: string | null | undefined) => StructuredReport | undefined,
): string | null {
  if (!waveRequiresVerification(wave.steps)) return null;
  const step = waveVerificationStep(wave.steps);
  if (!step) {
    return "This wave built something inspectable and its last step was not a verification step, so nothing external checked the result.";
  }
  const report = step.runId ? reportOf(step.runId) : undefined;
  if (!report || report.status !== "completed") {
    return `The verification step (step ${step.stepIndex + 1}) did not complete, so its evidence never arrived.`;
  }
  if (report.artifacts.length === 0) {
    return `The verification step (step ${step.stepIndex + 1}) reported no artifacts, so there is nothing showing what it actually inspected.`;
  }
  return null;
}

/**
 * The decision for a wave every step of which went terminal without producing
 * a single report (C3).
 *
 * The retry is offered on purpose: it is the operator's way to say "ask
 * anyway", and the digest it re-arms says plainly that every step is unknown.
 */
export function waveInterruptedDecision(): WaveVerdictDecision {
  return {
    phase: "needsOperator",
    closure: { reason: "wave-interrupted" },
    offerRetry: true,
  };
}

/**
 * The decision for a digest that could not be delivered at all.
 *
 * The retry is offered, and of all the retries this is the one that most
 * deserves to be: nothing here is the conductor's mistake or the workers'. A
 * send failed. The wave is finished, its reports exist, and pressing the
 * button re-delivers exactly the same digest under a new attempt marker. A
 * transient delivery failure is the single case where asking again is likely
 * to simply work — refusing to offer it was the only reason a whole wave's
 * work could be lost to one bad send.
 */
export function digestUndeliverableDecision(
  detail: string,
): WaveVerdictDecision {
  return {
    phase: "needsOperator",
    closure: { reason: "digest-undeliverable", detail },
    offerRetry: true,
  };
}

/** Phases the wave engine still spawns steps for. */
export function isWaveRunning(wave: WaveState): boolean {
  return wave.phase === "running";
}

/**
 * True while a wave still owes the operator something: it is spawning, waiting
 * on a digest, or waiting on a verdict.
 *
 * This is what makes "one wave at a time per conductor" checkable. A wave
 * parked on `needsOperator` is *not* live — it is a record backing the retry —
 * so a new root request may replace it, which is what already happens.
 */
export function isWaveLive(wave: WaveState): boolean {
  return (
    wave.phase === "running" ||
    wave.phase === "digestPending" ||
    wave.phase === "dispatchingDigest" ||
    wave.phase === "awaitingVerdict"
  );
}

/**
 * True when the wave has nothing left to do and its record may be dropped.
 *
 * `needsOperator` is deliberately *not* retired: it is the record of an
 * unfinished root request, it backs the manual retry, and dropping it would
 * make the retry button unable to find the wave it belongs to. It is dropped
 * when its conductor disappears (`pruneOrphanedWaves`) or when that conductor
 * admits a new plan, which is a new root request.
 */
export function isWaveRetired(wave: WaveState): boolean {
  return wave.phase === "accepted" || wave.phase === "revised";
}
