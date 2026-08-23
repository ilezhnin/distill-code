/**
 * The wave's closed loop, as pure decisions (D4).
 *
 * `waveEngine.ts` decides what a *running* wave does with its steps. This
 * module decides what happens after the last step is terminal:
 *
 * ```text
 *   running → digestPending → dispatchingDigest → awaitingVerdict
 *                                                      ├─ accept          → accepted
 *                                                      ├─ revise (cap ok) → revised + one new wave
 *                                                      ├─ revise (capped) → needsOperator
 *                                                      ├─ needs-operator  → needsOperator
 *                                                      └─ none / invalid  → needsOperator (Q5)
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
 */

import type { DistillVerdictParse } from "./distillVerdict";
import type { WaveStep } from "./distillWave";
import type { WavePhase, WaveState } from "./waveEngine";

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
  | "digest-undeliverable";

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
}): WaveVerdictDecision {
  const maxRevisions = input.maxRevisions ?? MAX_WAVE_REVISIONS;
  const { parse } = input;

  if (parse.kind === "none") {
    return {
      phase: "needsOperator",
      closure: { reason: "verdict-missing" },
      offerRetry: true,
    };
  }
  if (parse.kind === "invalid") {
    return {
      phase: "needsOperator",
      closure: { reason: "verdict-invalid", detail: parse.detail },
      offerRetry: true,
    };
  }

  const { verdict } = parse;
  if (verdict.outcome === "accept") {
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

/** The decision for a digest that could not be delivered at all. */
export function digestUndeliverableDecision(
  detail: string,
): WaveVerdictDecision {
  return {
    phase: "needsOperator",
    closure: { reason: "digest-undeliverable", detail },
    offerRetry: false,
  };
}

/** Phases the wave engine still spawns steps for. */
export function isWaveRunning(wave: WaveState): boolean {
  return wave.phase === "running";
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
