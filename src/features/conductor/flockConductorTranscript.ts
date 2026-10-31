import { i18n } from "@/shared/i18n";
import type { Message, MessageContent } from "@/shared/types/messages";

import { turnHasMutatingToolCall } from "./conductorSelfExecution";
import { VERDICT_FENCE_TAG, parseFlockVerdict } from "./flockVerdict";
import { WAVE_FENCE_TAG, parseFlockWave, type WaveStep } from "./flockWave";
import { roleDisplayName } from "./roleLayers";
import {
  conductorSelfExecutionBadgeText,
  waveVerdictProseFallback,
} from "./waveNotices";

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

export interface FlockConductorTranscriptOptions {
  /**
   * Localized one-liner shown in place of a `distill-wave` fence when the
   * conductor sent the plan with no prose around it. Never empty: the plan
   * message is the brigade chips' anchor, so it must survive distillation.
   */
  wavePlanLabel?: string;
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
 * plan (which `parseFlockVerdict` also reads, as a bare revision) is left to
 * the plan path and its own step list.
 */
function stripVerdictFence(block: MessageContent): MessageContent {
  if (block.type !== "text") return block;
  if (!block.text.includes(VERDICT_FENCE_TAG)) return block;
  const parse = parseFlockVerdict(block.text);
  if (parse.kind !== "verdict") return block;
  return {
    ...block,
    text: parse.prose || waveVerdictProseFallback(parse.verdict.outcome),
  };
}

/**
 * The Q6 badge: "the conductor changed something itself".
 *
 * The conductor is prompt-only — it plans or it answers (D3/Q6) — but it is an
 * ordinary session with an ordinary toolset, so the instruction can leak. The
 * operator decision was to make a leak *visible* rather than to forbid it at
 * the harness, and to revisit only if it happens for real.
 *
 * Only a turn that ran a state-changing tool is badged
 * (`conductorSelfExecution.ts`): reading to answer or to plan is what the
 * protocol asks for, and a warning on every such turn had taught the operator
 * to ignore the warning. The tool calls themselves are on screen like any
 * other turn's, so the badge points at steps the operator can open.
 */
function selfExecutionBadge(): MessageContent {
  return {
    type: "systemNotification",
    notificationType: "warning",
    text: conductorSelfExecutionBadgeText(),
  };
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
  { signature: string; distilled: Message }
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
    const parse = parseFlockWave(stripped.text);
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
 * The one access-mode vocabulary, shared by the plan step list and the wave
 * chips: the operator has to be able to match a chip to a line of the plan.
 */
export function waveStepAccessKey(step: WaveStep): string {
  return step.access === "all"
    ? "chat:conductor.wave.access.all"
    : "chat:conductor.wave.access.none";
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
 * One turn as the operator reads it — **the same object when nothing changed**.
 *
 * A conductor turn is shown like any other agent turn: its thinking and the
 * tools it ran collapse into the work panel above the answer, and stay open
 * and live while it works. What is the conductor's own is the protocol: a plan
 * fence becomes its numbered step list, a verdict fence becomes its prose, and
 * a turn that changed something is badged (Q6).
 *
 * Identity is the whole point of the caching: the transcript projection keys
 * its per-message items on the `Message` object, so a distiller that cloned
 * unconditionally would make every message a cache miss on every streamed
 * token. A clone happens only when a fence was rewritten or the badge added.
 */
function flockMessage(
  message: Message,
  wavePlanLabel: string,
  signature: string,
): Message {
  const cached = renderCache.get(message);
  if (cached && cached.signature === signature) return cached.distilled;

  const analysis = analyzeTurn(message);
  let content = analysis.blocks;
  const planSteps = analysis.planSteps;
  if (planSteps) {
    content = content.map((block, index) =>
      index === analysis.planBlockIndex && block.type === "text"
        ? {
            ...block,
            text: wavePlanBlockText(analysis, planSteps, wavePlanLabel),
          }
        : block,
    );
  }
  if (analysis.hasMutatingToolCall) {
    content = [selfExecutionBadge(), ...content];
  }

  const distilled =
    content === message.content
      ? message
      : { ...message, content: [...content] };
  renderCache.set(message, { signature, distilled });
  return distilled;
}

function flockSignature(wavePlanLabel: string): string {
  return `${i18n.language ?? ""}\u0000${wavePlanLabel}`;
}

export function flockConductorTranscript(
  messages: Message[],
  options: FlockConductorTranscriptOptions = {},
): Message[] {
  const wavePlanLabel =
    options.wavePlanLabel?.trim() || FALLBACK_WAVE_PLAN_LABEL;
  const signature = flockSignature(wavePlanLabel);

  const distilled: Message[] = [];
  let changed = false;
  for (const message of messages) {
    if (message.role === "user" || message.role === "system") {
      distilled.push(message);
      continue;
    }
    const next = flockMessage(message, wavePlanLabel, signature);
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
