import { LOOP_STATE_FENCE } from "./automationProtocol";
export {
  LOOP_TURN_PREFIX,
  LOOP_STATE_FENCE,
  loopPrompt,
} from "./automationProtocol";
import { automationCopy as copy } from "./automationCopy";
import { finalStateFence } from "./commands";

export const MIN_DELAY = 60_000;
export const DAY = MIN_DELAY * 60 * 24;
export const DEFAULT_LOOP_DELAY = 10 * MIN_DELAY;
export const MAX_CHAT_LOOPS = 5;

const units: Record<string, number> = {
  s: 1000,
  m: MIN_DELAY,
  h: 60 * MIN_DELAY,
  d: DAY,
};
function milliseconds(count: string, unit: string) {
  const result = Number(count) * units[unit[0].toLowerCase()];
  return Number.isSafeInteger(result) &&
    Number.isSafeInteger(result + Date.now())
    ? result
    : undefined;
}

type LoopCommand =
  | { action: "list" }
  | { action: "pause" | "resume" | "stop"; number?: number }
  | { action: "create"; prompt: string; intervalMs?: number; raised: boolean }
  | { action: "invalid"; reason: string };

export function parseLoopCommand(input: string): LoopCommand {
  const args = input.trim();
  if (!args || args === "list") return { action: "list" };
  const control = /^(pause|resume|stop|list)(?:\s+([\s\S]*))?$/.exec(args);
  if (control) {
    const [, action, target] = control;
    if (action === "stop" && target === "all") return { action };
    if (action === "pause" || action === "resume" || action === "stop") {
      if (!target && action !== "stop") return { action };
      if (target && /^[1-9]\d*$/.test(target))
        return { action, number: Number(target) };
    }
    return {
      action: "invalid",
      reason: copy("loopUsage"),
    };
  }
  const leading = /^(\d+)([smhd])(?:\s+|$)/i.exec(args);
  const trailing =
    !leading &&
    /(?:^|\s+)every\s+(\d+)\s+(seconds?|minutes?|hours?|days?|[smhd])$/i.exec(
      args,
    );
  const interval = leading || trailing;
  const prompt = (
    leading
      ? args.slice(leading[0].length)
      : trailing
        ? args.slice(0, trailing.index)
        : args
  ).trim();
  if (!prompt) return { action: "invalid", reason: copy("missingPrompt") };
  const ms = interval ? milliseconds(interval[1], interval[2]) : undefined;
  if (interval && ms === undefined)
    return { action: "invalid", reason: copy("intervalTooLarge") };
  return {
    action: "create",
    prompt,
    intervalMs: ms === undefined ? undefined : Math.max(MIN_DELAY, ms),
    raised: ms !== undefined && ms < MIN_DELAY,
  };
}

export function loopReply(text: string) {
  const state = finalStateFence(text, LOOP_STATE_FENCE);
  if (state?.done === true)
    return {
      done: true as const,
      note: typeof state.note === "string" ? state.note : copy("finished"),
    };
  const match =
    typeof state?.next === "string" &&
    /^(\d+)\s*(seconds?|minutes?|hours?|days?|[smhd])$/i.exec(
      state.next.trim(),
    );
  const ms = match
    ? Number(match[1]) * units[match[2][0].toLowerCase()]
    : typeof state?.next === "number" && Number.isFinite(state.next)
      ? state.next * 1000
      : DEFAULT_LOOP_DELAY;
  return {
    done: false as const,
    delay: Math.min(DAY, Math.max(MIN_DELAY, ms)),
  };
}
