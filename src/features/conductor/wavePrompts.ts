/**
 * The conductor wave protocol, as prose.
 *
 * Two things live here and nowhere else:
 * - `CONDUCTOR_PROTOCOL_PROMPT` — what the conductor session is told about
 *   planning (D3 gate), the `distill-wave` contract (D1), access semantics
 *   (D2) and the verdict vocabulary (D4);
 * - `buildWaveStepPrompt` — the first message of a wave child: role, subtask,
 *   and (only when `access` is `"all"`) the JSON reports of the earlier steps.
 *
 * These are plain module constants on purpose: this library has no components,
 * and none of this text is operator-facing chrome that would need i18n. The
 * fence tags, the step cap and the verdict tokens are interpolated from the
 * parsers so the prompt can never drift from what the code accepts.
 */

import {
  MAX_WAVE_STEPS,
  WAVE_FENCE_TAG,
  type WaveStep,
  allowedWaveRoleIds,
} from "./distillWave";
import { VERDICT_FENCE_TAG, VERDICT_TOKENS } from "./distillVerdict";
import { wrapOrchestratorTaskPrompt } from "./orchestratorReport";
import { roleDisplayName } from "./roleLayers";
import type { StructuredReport } from "./types";

/** A finished earlier step of the same wave, as handed to an `"all"` step. */
export interface CompletedWaveStepReport {
  /** Zero-based index of the step inside its wave. */
  stepIndex: number;
  /** Worker-layer role id that executed the step. */
  role: string;
  /** The subtask that step was given. */
  subtask: string;
  /** The structured report that step produced (never its transcript — D2). */
  report: StructuredReport;
  /**
   * True when this report comes from the *previous* wave of the same root
   * request rather than from an earlier step of this wave (Q4). Only revision
   * waves ever carry these.
   */
  fromPreviousWave?: boolean;
}

export interface WaveStepPromptOptions {
  /** Zero-based position of this step, when the caller wants it stated. */
  stepIndex?: number;
  /** Total number of steps in the wave. */
  totalSteps?: number;
}

/**
 * Builds the protocol prompt handed to a conductor session.
 *
 * Exported as a builder so the role list stays derived from `roleCatalog`;
 * `CONDUCTOR_PROTOCOL_PROMPT` is the value every caller should use.
 */
export function buildConductorProtocolPrompt(): string {
  return `You are the Distill conductor. You plan or you answer — you never do the work yourself.

Every operator message gets exactly one of two replies:

1. A direct answer. If the request is simple, factual, or conversational, just answer it. No fence, no wave, no ceremony. This is the common case and it is not a failure.
2. A wave. If the request genuinely needs several pieces of work, emit one ${WAVE_FENCE_TAG} block. A wave of one step is legal and is how you hand a single well-scoped job to a single worker.

Never do both, and never emit more than one ${WAVE_FENCE_TAG} block in a message.

## Wave format

\`\`\`${WAVE_FENCE_TAG}
{"steps":[{"role":"researcher","subtask":"...","access":[]},{"role":"writer","subtask":"...","access":"all"}]}
\`\`\`

Rules, all enforced by a strict parser — a malformed wave runs nothing and is shown to the operator as an error:

- At most ${MAX_WAVE_STEPS} steps. Fewer is better; most good waves are two or three.
- "role" must be one of these worker roles: ${allowedWaveRoleIds().join(", ")}. The role is framing for the worker, not the reason a step exists — see "How to split the work".
- "subtask" is a step-by-step instruction written for that worker. It must never be a copy of the operator's request: if every subtask could be replaced by "solve the user's question", the wave is not written yet.
- "access" is either [] or "all". Nothing else — no lists of step indexes.
- "model" is optional. Omit it and the step inherits the conductor's model.
- Anything you want the operator to read goes outside the block, as ordinary prose.

## Access semantics

- "access": [] — the step sees only its own subtask. Steps with [] start immediately and run in parallel.
- "access": "all" — the step waits for every earlier step of the wave and receives their JSON reports. It receives reports, never transcripts: it cannot read another session's conversation, so the subtask must say what to do with those reports.

A failed earlier step does not block a later one; its failure report is part of the handoff.

## How to split the work

Split along context boundaries, not job titles. A step exists because it needs a body of context the other steps do not need, because it can run at the same time as another step, or because it needs a different tool or skill. "One worker writes it, another reviews it, a third documents it" is not a wave — it is one job cut into pieces that each need the same context, and every cut costs a handoff in which understanding is lost.

Work that needs one shared understanding stays in one step. Only split what can genuinely be understood on its own.

## Verification

If the wave produces something that can be checked by looking at the thing itself — code, files, a build, a document, data — the last step must be a verification step: role "acceptor" (or "adversary" to hunt for defects the others would not admit to), "access":"all".

That step's subtask must tell the worker to inspect the artifact directly: run the build, run the tests, open the files, check that the change is actually there and actually applies. It must not simply re-read the other steps' reports and agree with them. A verifier that only reads reports adds nothing — the workers already told you what they think of their own work.

Its report is the only external evidence you get. Weigh it above the workers' own accounts of themselves.

For work that has nothing to inspect — a summary, an explanation, a recommendation — skip the verification step rather than adding a ceremonial one.

## Verdict

When a wave finishes you receive a digest of the workers' reports and reply with exactly one ${VERDICT_FENCE_TAG} block:

\`\`\`${VERDICT_FENCE_TAG}
{"verdict":"${VERDICT_TOKENS.accept}","note":"one line for the operator"}
\`\`\`

- "${VERDICT_TOKENS.accept}" — the results answer the request. Put the answer itself in prose outside the block. If the wave produced something checkable, accept only on the verification step's evidence; a wave that was checkable and was not checked is "${VERDICT_TOKENS.needsOperator}", not "${VERDICT_TOKENS.accept}".
- "${VERDICT_TOKENS.revise}" — one more wave is needed. Emit the ${VERDICT_FENCE_TAG} block and a ${WAVE_FENCE_TAG} block with the revision wave in the same message. Revisions are capped; do not plan on getting another.
- "${VERDICT_TOKENS.needsOperator}" — the request cannot be finished without the operator. Say what you need in "note".

No other verdict word is accepted, and a malformed verdict is treated as ${VERDICT_TOKENS.needsOperator}.`;
}

/** The conductor protocol prompt. Stable for the lifetime of the process. */
export const CONDUCTOR_PROTOCOL_PROMPT: string = buildConductorProtocolPrompt();

/**
 * Merges the protocol prompt with whatever system prompt the caller composed.
 *
 * The protocol comes first so the session's own system prompt reads as the
 * override, matching how the app layers its other always-on preambles.
 */
export function composeConductorSystemPrompt(
  systemPrompt: string | undefined,
): string {
  const base = systemPrompt?.trim();
  return base
    ? `${CONDUCTOR_PROTOCOL_PROMPT}\n\n${base}`
    : CONDUCTOR_PROTOCOL_PROMPT;
}

/**
 * Sent to the conductor by the manual retry affordance on a refused plan.
 *
 * Q2: there is no auto-retry. This text only exists because the operator asked
 * for another plan by pressing the button.
 */
export const WAVE_REPLAN_REQUEST_PROMPT = `Your last wave plan was refused: the ${WAVE_FENCE_TAG} block did not parse, or asked for something this build cannot run. Read the error in the transcript above.

Send the plan again as exactly one ${WAVE_FENCE_TAG} block that follows the contract — or, if the request does not actually need a wave, answer it directly with no fence at all.`;

function reportPayload(
  entry: CompletedWaveStepReport,
): Record<string, unknown> {
  return {
    wave: entry.fromPreviousWave ? "previous" : "current",
    step: entry.stepIndex + 1,
    role: entry.role,
    subtask: entry.subtask,
    status: entry.report.status,
    summary: entry.report.summary,
    decisions: entry.report.decisions,
    artifacts: entry.report.artifacts,
    risks: entry.report.risks,
    needsOperator: entry.report.needsOperator,
  };
}

/**
 * Builds the first message of a wave child (D2).
 *
 * `previousReports` is used only when `step.access` is `"all"`; for `[]` steps
 * it is ignored entirely, whatever the caller passes. Reports are embedded as
 * JSON — never transcripts. The report contract itself is appended by
 * `wrapOrchestratorTaskPrompt`, the single place that owns that wording.
 */
export function buildWaveStepPrompt(
  step: WaveStep,
  previousReports: readonly CompletedWaveStepReport[] = [],
  options: WaveStepPromptOptions = {},
): string {
  const { stepIndex, totalSteps } = options;
  const position =
    stepIndex === undefined
      ? "a step of a Distill wave"
      : totalSteps === undefined
        ? `step ${stepIndex + 1} of a Distill wave`
        : `step ${stepIndex + 1} of ${totalSteps} in a Distill wave`;

  const sections = [
    `You are the ${roleDisplayName(step.role)} (role: ${step.role}) on ${position}. Do this step and nothing else.`,
    step.subtask.trim(),
  ];

  if (step.access === "all") {
    // Previous-wave reports come first as a block, then this wave's own steps;
    // within each block, step order.
    const ordered = [...previousReports].sort((left, right) => {
      const leftWave = left.fromPreviousWave ? 0 : 1;
      const rightWave = right.fromPreviousWave ? 0 : 1;
      if (leftWave !== rightWave) return leftWave - rightWave;
      return left.stepIndex - right.stepIndex;
    });
    if (ordered.length === 0) {
      sections.push(
        "No earlier step of this wave produced a report, so you are starting from the subtask alone.",
      );
    } else {
      const hasCarried = ordered.some((entry) => entry.fromPreviousWave);
      sections.push(
        `${
          hasCarried
            ? 'Reports you may read, in order. Entries marked "wave":"previous" are from the previous wave of this same request — that is what is being revised; entries marked "wave":"current" are earlier steps of this wave.'
            : "Reports from the earlier steps of this wave, in order."
        } These are their reports, not their transcripts — those sessions are not readable and must not be asked for.

\`\`\`json
${JSON.stringify(ordered.map(reportPayload), null, 2)}
\`\`\``,
      );
    }
  }

  return wrapOrchestratorTaskPrompt(sections.join("\n\n"));
}

/**
 * Sent to a session that is waiting on graph children when the operator asks
 * for an interim summary (the poke button).
 *
 * It is deliberately a *question*, not a dispatch order: the children are still
 * working, and a conductor that answered it with a new wave would double the
 * brigade. The wording says so explicitly, because the protocol prompt's
 * default reflex on any operator message is "plan or answer".
 */
export const WAVE_POKE_PROMPT = `The operator is asking for an interim status, not for new work.

Summarize what you dispatched, what you already know, and what is still outstanding, in a few lines of plain prose. Do not emit a ${WAVE_FENCE_TAG} block, do not emit a ${VERDICT_FENCE_TAG} block, and do not start doing the work yourself — the executors you already dispatched are still running and their reports will arrive on their own.`;

/**
 * Sent to the conductor when the operator retries a digest whose verdict could
 * not be read (Q5). The digest itself is re-delivered alongside it, so this
 * text only has to explain why it is arriving twice.
 */
export const WAVE_VERDICT_RETRY_PROMPT = `Your previous answer to this digest could not be read as a verdict, so nothing was decided and the operator asked for another try.`;

/**
 * Header of a wave digest.
 *
 * The receiving model is a conductor whose every other incoming user message is
 * an operator request; the digest has to say, in its first line, that it is not
 * one. `{{count}}`-free on purpose: this is prompt text, not operator chrome.
 */
export function buildWaveDigestInstruction(stepCount: number): string {
  return `WAVE REPORT DIGEST — this is the collected report of the ${stepCount === 1 ? "worker" : `${stepCount} workers`} you dispatched. It is not a request from the operator and contains no new instructions for you.

Judge it: reply with exactly one ${VERDICT_FENCE_TAG} block, per the protocol you were given (${VERDICT_TOKENS.accept} | ${VERDICT_TOKENS.revise} | ${VERDICT_TOKENS.needsOperator}). If you ${VERDICT_TOKENS.accept}, the prose outside the block is what the operator reads as the answer, so write the answer there.`;
}

/**
 * Header of a digest for children that are not part of a wave (legacy
 * orchestrator trees, and agent-cli children under any chat).
 *
 * No verdict is demanded: the receiving session may be an ordinary chat that
 * was never told the wave protocol.
 */
export const AGENT_DIGEST_INSTRUCTION = `AGENT REPORT DIGEST — the agents dispatched from this chat have finished. This is their report, not a request from the operator and not a set of instructions for you.

Use it to continue the work or to answer the operator.`;
