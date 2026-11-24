import type { CommandName } from "./commands";
import type { MessageMetadata } from "@/shared/types/messages";

export const GOAL_TURN_PREFIX = "goal-turn:";
export const LOOP_TURN_PREFIX = "loop-turn:";
export const GOAL_REPORT_PREFIX = "goal-report:";
export const LOOP_REPORT_PREFIX = "loop-report:";
export const LOOP_STATE_FENCE = "flock-loop-state";

export const GOAL_STATE_FENCE = "flock-goal-state";

/**
 * True for a delivery id in the namespace the app keeps for the messages it
 * sends for a goal or a loop.
 *
 * The id is what says "Flock sent this": the transcript labels such a
 * message as the app's and folds its body, the composer's indicator reads
 * it as the turn at work, and recovery after a restart counts it as a turn
 * of the goal or loop. `flockctl session send` therefore refuses a caller's
 * `--delivery-id` in this namespace, so that only the app can write one.
 */
export function isAutomationDeliveryId(deliveryId: string): boolean {
  return [
    GOAL_TURN_PREFIX,
    LOOP_TURN_PREFIX,
    GOAL_REPORT_PREFIX,
    LOOP_REPORT_PREFIX,
  ].some((prefix) => deliveryId.startsWith(prefix));
}

export function goalPrompt(objective: string): string {
  return `Work toward this chat's goal:\n\n${objective}\n\nEnd your reply with a fenced ${GOAL_STATE_FENCE} JSON object. Use continue for more work, reached when complete, or blocked when you need help. Give the reason in note.\n\n\`\`\`${GOAL_STATE_FENCE}\n{"status":"continue","note":"progress or reason"}\n\`\`\``;
}

export function loopPrompt(prompt: string, selfPaced: boolean) {
  const schedule = selfPaced
    ? ' Set "next" to a delay such as "5m" (1 minute to 24 hours, default 10 minutes).'
    : "";
  return `Run this chat's loop:\n\n${prompt}\n\nEnd your reply with a fenced ${LOOP_STATE_FENCE} JSON object.${schedule} To finish the loop use {"done":true,"note":"reason"}.`;
}

// ACP history can lose the sender metadata. Match the complete generated
// envelope on replay, so quoting a single instruction stays ordinary prose.
const slot = "\u0000";
const wrappers = [
  ["goal", goalPrompt(slot)],
  ["loop", loopPrompt(slot, true)],
  ["loop", loopPrompt(slot, false)],
] as const;
const envelopes = wrappers.map(([kind, template]) => {
  const [prefix, suffix] = template.split(slot);
  const instructions = suffix.trim();
  const intro = instructions.slice(0, instructions.indexOf(".") + 1);
  return { kind, prefix, suffix, instructions, intro };
});

function automationTurnKind(receipt?: string): CommandName | undefined {
  if (receipt?.startsWith(GOAL_TURN_PREFIX)) return "goal";
  if (receipt?.startsWith(LOOP_TURN_PREFIX)) return "loop";
}

export function automationSenderKind(
  receipt?: string,
): CommandName | undefined {
  if (receipt?.startsWith(GOAL_REPORT_PREFIX)) return "goal";
  if (receipt?.startsWith(LOOP_REPORT_PREFIX)) return "loop";
  return automationTurnKind(receipt);
}

export function automationTurn(
  text: string,
  metadata?: MessageMetadata,
): { kind: CommandName; task: string; instructions?: string } | undefined {
  const sender = automationTurnKind(metadata?.distillDeliveryId);
  if (
    metadata?.origin &&
    (metadata.origin !== "distillctl_cross_session" || !sender)
  )
    return;
  for (const { kind, prefix, suffix, instructions } of envelopes) {
    if (
      (!sender || kind === sender) &&
      text.startsWith(prefix) &&
      text.endsWith(suffix)
    )
      return {
        kind,
        task: text.slice(prefix.length, -suffix.length),
        instructions,
      };
  }
  // A loop skill can already carry a shortened display text.
  return sender ? { kind: sender, task: text } : undefined;
}

// Host transcript exports concatenate assistant-audience and public prompt
// blocks. Older lists can also contain a collapsed, truncated envelope.
export function automationPreviewTask(text: string) {
  for (const { prefix, instructions } of envelopes) {
    const boundary = text.lastIndexOf(instructions);
    if (boundary >= 0) {
      const publicBlock = text.slice(boundary + instructions.length);
      if (publicBlock.trim()) return publicBlock.trimStart();
      const heading = text.lastIndexOf(prefix, boundary);
      if (heading >= 0)
        return text.slice(heading + prefix.length, boundary).trimEnd();
      return text.slice(0, boundary).trimEnd();
    }
  }
  for (const { prefix, intro } of envelopes) {
    const heading = prefix.trimEnd();
    if (text.startsWith(intro) || text === intro.slice(0, -1)) return "";
    if (!text.startsWith(heading)) continue;
    const task = text.slice(heading.length).trimStart();
    const start = task.lastIndexOf(intro);
    if (start >= 0) return task.slice(0, start).trimEnd();

    // The cap can fall inside the first sentence of the instruction.
    const clipped = task.replace(/\u2026$/, "");
    const tail = clipped.lastIndexOf(` ${intro[0]}`);
    if (tail >= 0 && intro.startsWith(clipped.slice(tail + 1)))
      return clipped.slice(0, tail);
    return task;
  }
  return text;
}
