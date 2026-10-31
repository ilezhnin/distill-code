import type { Message, MessageContent } from "@/shared/types/messages";

import { turnHasChangingToolCall } from "./conductorSelfExecution";
import { VERDICT_FENCE_TAG, parseFlockVerdict } from "./flockVerdict";
import { WAVE_FENCE_TAG, parseFlockWave, type WaveStep } from "./flockWave";
import {
  conductorSelfExecutionBadgeText,
  waveVerdictProseFallback,
} from "./waveNotices";

/** Shared empty result so a transcript with no plans keeps a stable identity. */
export const NO_WAVE_PLAN_STEPS: ReadonlyMap<string, readonly WaveStep[]> =
  new Map<string, readonly WaveStep[]>();

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
 * the plan renderer and its own step list.
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
 * Only a turn that visibly changed something is badged
 * (`conductorSelfExecution.ts`): reading to answer or to plan is what the
 * protocol asks for. The tool calls themselves are on screen like any other
 * turn's, so the badge points at steps the operator can open.
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
  /** Steps of the turn's plan, frozen. `null` when the turn carried no plan. */
  planSteps: readonly WaveStep[] | null;
  /** True when the turn ran a tool that changed something — the Q6 leak. */
  changedSomething: boolean;
}

const analysisCache = new WeakMap<Message, ConductorTurnAnalysis>();
const renderCache = new WeakMap<
  Message,
  { language: string; distilled: Message }
>();

function analyzeTurn(message: Message): ConductorTurnAnalysis {
  const cached = analysisCache.get(message);
  if (cached) return cached;

  let blocks = message.content;
  let rewritten: MessageContent[] | null = null;
  let planSteps: readonly WaveStep[] | null = null;

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
    if (parse.kind === "plan") planSteps = Object.freeze(parse.steps.slice());
  }

  if (rewritten) blocks = rewritten;
  const analysis: ConductorTurnAnalysis = {
    blocks,
    planSteps,
    changedSomething: turnHasChangingToolCall(message.content),
  };
  analysisCache.set(message, analysis);
  return analysis;
}

/**
 * The one access-mode vocabulary, shared by the plan's steps and the wave
 * chips: the operator has to be able to match a chip to a line of the plan.
 */
export function waveStepAccessKey(step: WaveStep): string {
  return step.access === "all"
    ? "chat:conductor.wave.access.all"
    : "chat:conductor.wave.access.none";
}

/**
 * One turn as the operator reads it — **the same object when nothing changed**.
 *
 * A conductor turn is shown like any other agent turn: its thinking and the
 * tools it ran collapse into the work panel above the answer, and stay open
 * and live while it works. What is the conductor's own is the protocol: a
 * verdict fence becomes its prose, a plan fence stays in the text for the
 * plan renderer (`ui/WavePlanRecord.tsx`) to draw as its steps, and a turn
 * that changed something is badged (Q6).
 *
 * Identity is the whole point of the caching: the transcript projection keys
 * its per-message items on the `Message` object, so a distiller that cloned
 * unconditionally would make every message a cache miss on every streamed
 * token. A clone happens only when a fence was rewritten or the badge added.
 */
function flockMessage(message: Message, language: string): Message {
  const cached = renderCache.get(message);
  if (cached && cached.language === language) return cached.distilled;

  const analysis = analyzeTurn(message);
  const content = analysis.changedSomething
    ? [selfExecutionBadge(), ...analysis.blocks]
    : analysis.blocks;
  const distilled =
    content === message.content
      ? message
      : { ...message, content: [...content] };
  renderCache.set(message, { language, distilled });
  return distilled;
}

/**
 * The conductor transcript as the operator reads it. `language` is the UI
 * language the badge is worded in; a change of it re-words cached turns.
 */
export function flockConductorTranscript(
  messages: Message[],
  language: string,
): Message[] {
  const distilled: Message[] = [];
  let changed = false;
  for (const message of messages) {
    if (message.role === "user" || message.role === "system") {
      distilled.push(message);
      continue;
    }
    const next = flockMessage(message, language);
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
