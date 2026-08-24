import { i18n } from "@/shared/i18n";
import type { Message, MessageContent } from "@/shared/types/messages";

import { turnHasMutatingToolCall } from "./conductorSelfExecution";
import { VERDICT_FENCE_TAG, parseDistillVerdict } from "./distillVerdict";
import { WAVE_FENCE_TAG, parseDistillWave, type WaveStep } from "./distillWave";
import { roleDisplayName } from "./roleLayers";
import {
  conductorSelfExecutionBadgeText,
  waveVerdictProseFallback,
} from "./waveNotices";

const VISIBLE_BLOCK_TYPES = new Set<MessageContent["type"]>([
  "text",
  "image",
  "mcpApp",
]);

/**
 * Tool blocks are stripped from every conductor turn *except* one that trips
 * the Q6 self-execution badge.
 *
 * The badge tells the operator "the conductor did the work itself"; stripping
 * the tool calls at the same time leaves a warning with nothing behind it. On
 * the turn that leaks, the calls *are* the evidence, so they stay.
 */
const SELF_EXECUTION_EVIDENCE_TYPES = new Set<MessageContent["type"]>([
  "toolRequest",
  "toolResponse",
]);

/**
 * Last-resort stand-in for a plan message whose prose was empty.
 *
 * The only production caller passes a translated `wavePlanLabel`; this constant
 * exists so a future caller that forgets cannot make the chip host disappear.
 */
const FALLBACK_WAVE_PLAN_LABEL = "Plan for the brigade below.";

/** Shared empty result so a transcript with no plans keeps a stable identity. */
export const NO_WAVE_PLAN_STEPS: ReadonlyMap<string, readonly WaveStep[]> =
  new Map<string, readonly WaveStep[]>();

export interface DistillConductorTranscriptOptions {
  /**
   * Localized one-liner shown in place of a `distill-wave` fence when the
   * conductor sent the plan with no prose around it. Never empty: the plan
   * message is the brigade chips' anchor, so it must survive distillation.
   */
  wavePlanLabel?: string;
}

function isVisibleConductorBlock(
  block: MessageContent,
  keepToolEvidence: boolean,
): boolean {
  if (block.type === "systemNotification") {
    return (
      block.notificationType === "error" || block.notificationType === "warning"
    );
  }
  if (keepToolEvidence && SELF_EXECUTION_EVIDENCE_TYPES.has(block.type)) {
    return true;
  }
  return VISIBLE_BLOCK_TYPES.has(block.type);
}

function hasVisibleConductorContent(
  content: readonly MessageContent[],
): boolean {
  return content.some((block) => {
    if (block.type === "text") {
      return block.text.trim().length > 0;
    }
    return true;
  });
}

/**
 * Replace a machine-facing verdict with the prose that came with it.
 *
 * The verdict fence is the conductor's answer to a digest, and on `accept` the
 * prose around it *is* the operator's answer (D4) — leaving raw protocol JSON
 * next to it would make the answer unreadable. Only a `kind: "verdict"` parse
 * is rewritten: an unreadable verdict stays visible beside the notice that
 * explains it, and a half-streamed one parses as invalid and is left alone
 * until it settles.
 *
 * Gated on the message actually containing a verdict fence, so a plain wave
 * plan (which `parseDistillVerdict` also reads, as a bare revision) is left to
 * the plan path and its own step list.
 */
function stripVerdictFence(block: MessageContent): MessageContent {
  if (block.type !== "text") return block;
  if (!block.text.includes(VERDICT_FENCE_TAG)) return block;
  const parse = parseDistillVerdict(block.text);
  if (parse.kind !== "verdict") return block;
  return {
    ...block,
    text: parse.prose || waveVerdictProseFallback(parse.verdict.outcome),
  };
}

/**
 * The Q6 badge: "the conductor is doing the work itself".
 *
 * The conductor is prompt-only — it plans or it answers (D3/Q6) — but it is an
 * ordinary session with an ordinary toolset, so the instruction can leak. The
 * operator decision was to make a leak *visible* rather than to forbid it at
 * the harness, and to revisit only if it happens for real.
 *
 * Tiered by tool kind (`conductorSelfExecution.ts`): read-only exploration is
 * quiet — its tool blocks are stripped like any other technical chatter — and
 * only a turn that ran a state-changing tool is badged. Warning on every
 * grep-to-answer turn had taught the operator to ignore the warning.
 *
 * It has to be minted here rather than in the bubble, because this is the last
 * layer that can see a tool call at all. Derived from the turn's own content,
 * appended to the turn it belongs to; nothing is stored anywhere.
 */
function selfExecutionBadge(
  content: readonly MessageContent[],
): MessageContent | null {
  return turnHasMutatingToolCall(content)
    ? {
        type: "systemNotification",
        notificationType: "warning",
        text: conductorSelfExecutionBadgeText(),
      }
    : null;
}

/**
 * What one conductor turn is, independent of any localized rendering.
 *
 * Computed once per `Message` object and cached on it, because the whole
 * transcript is re-distilled on every streamed token and only the tail message
 * is ever a new object.
 */
interface ConductorTurnAnalysis {
  /**
   * `message.content` with verdict fences already replaced. Block identity is
   * preserved for every block that was not rewritten.
   */
  blocks: readonly MessageContent[];
  /** Index into `blocks` of the block that carried the plan fence, or -1. */
  planBlockIndex: number;
  /** Steps of that plan, frozen. `null` when the turn carried no plan. */
  planSteps: readonly WaveStep[] | null;
  /** The plan message with its fence removed, trimmed. May be empty. */
  planProse: string;
  /** True when the turn ran a state-changing tool — the Q6 leak. */
  hasMutatingToolCall: boolean;
}

const analysisCache = new WeakMap<Message, ConductorTurnAnalysis>();
const renderCache = new WeakMap<
  Message,
  { signature: string; distilled: Message | null }
>();

function analyzeTurn(message: Message): ConductorTurnAnalysis {
  const cached = analysisCache.get(message);
  if (cached) return cached;

  let blocks = message.content;
  let rewritten: MessageContent[] | null = null;
  let planBlockIndex = -1;
  let planSteps: readonly WaveStep[] | null = null;
  let planProse = "";

  for (let index = 0; index < message.content.length; index += 1) {
    const original = message.content[index];
    if (original === undefined) continue;
    const stripped = stripVerdictFence(original);
    if (stripped !== original) {
      rewritten = rewritten ?? [...message.content];
      rewritten[index] = stripped;
    }
    if (planSteps) continue;
    // Cheap reject before the fence scan: this runs over the whole transcript
    // on every render of a conductor chat, i.e. on every streamed token.
    if (stripped.type !== "text" || !stripped.text.includes(WAVE_FENCE_TAG)) {
      continue;
    }
    const parse = parseDistillWave(stripped.text);
    // Only a `kind: "plan"` parse is rewritten. An `invalid` parse keeps its
    // raw text so the operator can read the broken block next to the error
    // notice — and that is also what protects a still-streaming message, whose
    // half-written fence parses as `unterminated-fence`.
    if (parse.kind !== "plan") continue;
    planBlockIndex = index;
    planSteps = Object.freeze(parse.steps.slice());
    planProse = parse.prose;
  }

  if (rewritten) blocks = rewritten;
  const analysis: ConductorTurnAnalysis = {
    blocks,
    planBlockIndex,
    planSteps,
    planProse,
    hasMutatingToolCall: turnHasMutatingToolCall(message.content),
  };
  analysisCache.set(message, analysis);
  return analysis;
}

/**
 * The plan, rendered where its fence was, as a compact numbered step list.
 *
 * Failure attribution is the reason this exists: when a wave returns a wrong
 * answer the operator has to be able to tell *which step* to blame, and the
 * chips below carry the same step numbers. Step number, role, access mode and
 * the subtask in the conductor's own words — nothing else, because this is a
 * diagnostic affordance and not a dashboard.
 */
/**
 * The one access-mode vocabulary, shared by the plan step list and the wave
 * chips: the operator has to be able to match a chip to a line of the plan.
 */
export function waveStepAccessKey(step: WaveStep): string {
  return step.access === "all"
    ? "chat:conductor.wave.access.all"
    : "chat:conductor.wave.access.none";
}

export function renderWavePlanSteps(steps: readonly WaveStep[]): string {
  return steps
    .map((step, index) =>
      i18n.t("chat:conductor.wave.plan.stepLine", {
        index: index + 1,
        role: roleDisplayName(step.role),
        access: i18n.t(waveStepAccessKey(step)),
        subtask: step.subtask,
      }),
    )
    .join("\n");
}

function wavePlanBlockText(
  analysis: ConductorTurnAnalysis,
  steps: readonly WaveStep[],
  wavePlanLabel: string,
): string {
  return `${analysis.planProse || wavePlanLabel}\n\n${renderWavePlanSteps(steps)}`;
}

/**
 * One turn, distilled — **returning the same object when nothing changed**.
 *
 * Identity is the whole point: the transcript projection caches its per-message
 * items in `WeakMap`s keyed on the `Message` object, so a distiller that clones
 * unconditionally makes every message a cache miss on every streamed token.
 * A clone happens only when a block was filtered out, a fence was rewritten, or
 * the self-execution badge was prepended.
 */
function distillMessage(
  message: Message,
  wavePlanLabel: string,
  signature: string,
): Message | null {
  const cached = renderCache.get(message);
  if (cached && cached.signature === signature) return cached.distilled;

  const analysis = analyzeTurn(message);
  const badge = analysis.hasMutatingToolCall
    ? selfExecutionBadge(message.content)
    : null;
  const keepToolEvidence = badge !== null;

  let changed = analysis.blocks !== message.content;
  const content: MessageContent[] = [];
  for (let index = 0; index < analysis.blocks.length; index += 1) {
    const block = analysis.blocks[index];
    if (block === undefined) continue;
    if (!isVisibleConductorBlock(block, keepToolEvidence)) {
      changed = true;
      continue;
    }
    if (index === analysis.planBlockIndex && analysis.planSteps) {
      content.push({
        ...(block as Extract<MessageContent, { type: "text" }>),
        text: wavePlanBlockText(analysis, analysis.planSteps, wavePlanLabel),
      });
      changed = true;
      continue;
    }
    content.push(block);
  }

  // Fences are rewritten before the emptiness check: a plan-only message is the
  // wave's `anchorMessageId`, so dropping it would strand the brigade chips
  // that hang off it.
  let distilled: Message | null;
  if (!hasVisibleConductorContent(content) && !badge) {
    distilled = null;
  } else if (!badge && !changed) {
    distilled = message;
  } else {
    distilled = {
      ...message,
      content: badge ? [badge, ...content] : content,
    };
  }

  renderCache.set(message, { signature, distilled });
  return distilled;
}

function distillSignature(wavePlanLabel: string): string {
  return `${i18n.language ?? ""} ${wavePlanLabel}`;
}

export function distillConductorTranscript(
  messages: Message[],
  options: DistillConductorTranscriptOptions = {},
): Message[] {
  const wavePlanLabel =
    options.wavePlanLabel?.trim() || FALLBACK_WAVE_PLAN_LABEL;
  const signature = distillSignature(wavePlanLabel);

  const distilled: Message[] = [];
  let changed = false;
  for (const message of messages) {
    if (message.role === "user" || message.role === "system") {
      distilled.push(message);
      continue;
    }
    const next = distillMessage(message, wavePlanLabel, signature);
    if (next === null) {
      changed = true;
      continue;
    }
    if (next !== message) changed = true;
    distilled.push(next);
  }
  // The array identity matters as much as the message identities: every
  // consumer downstream memoizes on it.
  return changed ? distilled : messages;
}

/**
 * The wave plans this transcript carries, keyed by the message that carried
 * them — the same message the wave's brigade chips are anchored to.
 *
 * Read by the chip row so a chip can name its step's access mode. The plan
 * message is the only durable record of it: the wave itself is removed from
 * the engine state the moment the conductor accepts (`waveLifecycle.ts`), and
 * failure attribution happens *after* that.
 */
export function collectWavePlanSteps(
  messages: readonly Message[],
): ReadonlyMap<string, readonly WaveStep[]> {
  let plans: Map<string, readonly WaveStep[]> | null = null;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const steps = analyzeTurn(message).planSteps;
    if (!steps) continue;
    plans = plans ?? new Map<string, readonly WaveStep[]>();
    plans.set(message.id, steps);
  }
  return plans ?? NO_WAVE_PLAN_STEPS;
}
