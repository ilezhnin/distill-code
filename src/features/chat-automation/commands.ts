import { GOAL_TURN_PREFIX, GOAL_STATE_FENCE } from "./automationProtocol";
export {
  GOAL_TURN_PREFIX,
  GOAL_STATE_FENCE,
  goalPrompt,
} from "./automationProtocol";
import { automationCopy as copy } from "./automationCopy";
import type { MessageMetadata } from "@/shared/types/messages";

export const GOAL_DEFAULT_TURNS = 30;
export const GOAL_MAX_TURNS = 200;

type LocalHandler = (
  sessionId: string,
  args: string,
  metadata?: Partial<MessageMetadata>,
) => void;
const handlers = {
  loop: async (): Promise<LocalHandler> => {
    const { handleLoopCommand, prepareLoopDispatch } = await import(
      "./loopRuntime"
    );
    await prepareLoopDispatch();
    return handleLoopCommand;
  },
  goal: async (): Promise<LocalHandler> => {
    const { handleGoalCommand, prepareGoalDispatch } = await import(
      "./goalRuntime"
    );
    await prepareGoalDispatch();
    return handleGoalCommand;
  },
};
export type CommandName = keyof typeof handlers;
export const automationCommandNames = Object.keys(handlers) as CommandName[];
export const loadAutomationHandler = (name: CommandName) => handlers[name]();
/**
 * The chat command a message is, or `null` for an ordinary message.
 *
 * A command is the operator's: text typed into this chat's composer. What
 * another session or `flockctl session send` delivered is text for the
 * agent, even when it opens with a command's name. Read as a command, one
 * call from any agent set a goal of two hundred turns in another chat, or
 * paused the operator's own.
 */
export function automationCommand(
  text: string,
  metadata?: Pick<MessageMetadata, "origin">,
) {
  if (metadata?.origin === "distillctl_cross_session") return null;
  if (!text.trimStart().startsWith("/")) return null;
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const name = match?.[1].toLowerCase();
  if (!name || !Object.hasOwn(handlers, name)) return null;
  return { name: name as CommandName, args: match?.[2] ?? "" };
}

export type GoalCommand =
  | { action: "status" | "pause" | "resume" | "clear" }
  | { action: "set"; objective: string; maxTurns: number; budget?: number }
  | { action: "invalid"; reason: string };

export function parseGoalCommand(args: string): GoalCommand {
  if (!args || args === "status") return { action: "status" };
  if (args === "pause" || args === "resume" || args === "clear")
    return { action: args };
  const flags = /(?:^|\s)--(?:max-turns|budget)(?=\s|$)/.exec(args);
  const objective = args.slice(0, flags?.index ?? args.length).trim();
  if (!objective)
    return {
      action: "invalid",
      reason: copy("missingObjective"),
    };
  const options = flags ? args.slice(flags.index).trim().split(/\s+/) : [];
  const values = new Map<string, number>();
  for (let i = 0; i < options.length; i += 2) {
    const name = options[i];
    const value = Number(options[i + 1]);
    if (
      !["--budget", "--max-turns"].includes(name) ||
      values.has(name) ||
      !/^\d+$/.test(options[i + 1]) ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      (name === "--max-turns" && value > GOAL_MAX_TURNS)
    ) {
      return {
        action: "invalid",
        reason: copy("goalOptions", { max: GOAL_MAX_TURNS }),
      };
    }
    values.set(name, value);
  }
  return {
    action: "set",
    objective,
    maxTurns: values.get("--max-turns") ?? GOAL_DEFAULT_TURNS,
    budget: values.get("--budget"),
  };
}

export function goalTurnPrefix(goalId: string) {
  return `${GOAL_TURN_PREFIX}${goalId}:`;
}
export function goalTurnDeliveryId(goalId: string, turn: number) {
  return `${goalTurnPrefix(goalId)}${turn}`;
}

export function goalReply(
  text: string,
): { status: "continue" | "reached" | "blocked"; note: string } | null {
  const value = finalStateFence(text, GOAL_STATE_FENCE);
  return value &&
    (value.status === "continue" ||
      value.status === "reached" ||
      value.status === "blocked") &&
    typeof value.note === "string"
    ? { status: value.status, note: value.note }
    : null;
}

export function finalStateFence(
  text: string,
  tag: string,
): Record<string, unknown> | null {
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.pop() !== "```") return null;
  const start = lines.lastIndexOf(`\`\`\`${tag}`);
  if (start < 0) return null;
  try {
    const value = JSON.parse(lines.slice(start + 1).join("\n"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}
