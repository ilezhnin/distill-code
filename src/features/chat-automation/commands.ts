import { GOAL_TURN_PREFIX, GOAL_STATE_FENCE } from "./automationProtocol";
export {
  GOAL_TURN_PREFIX,
  GOAL_STATE_FENCE,
  goalPrompt,
} from "./automationProtocol";
import { automationCopy as copy } from "./automationCopy";
import { protocolBlocks } from "@/shared/lib/protocolFences";
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
 * Where a message that may be a chat command came from, when it is the
 * operator's: typed into the chat's composer, or sent with flockctl from the
 * operator's own terminal (a call without the agent mark). Every other
 * message has none.
 */
export type AutomationCommandOrigin = "composer" | "operator-terminal";

/**
 * The chat command a message is, or `null` for an ordinary message.
 *
 * A command is the operator's, so only the origins above make one. Anything
 * else is text for the agent even when it opens with a command's name:
 * another session's message, an agent's flockctl call, the app's own text,
 * a hand-over block, a wave prompt. Read as a command, one call from any
 * agent set a goal of two hundred turns in another chat, or paused the
 * operator's own.
 */
export function automationCommand(
  text: string,
  origin?: AutomationCommandOrigin,
) {
  if (origin !== "composer" && origin !== "operator-terminal") return null;
  return automationCommandSyntax(text);
}

/**
 * The command a message is written as, whoever sent it. Only for a reader
 * that must keep such text from being taken for a command; whether a
 * message runs as one is {@link automationCommand}'s answer.
 */
export function automationCommandSyntax(text: string) {
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
  // A control word is the whole argument, whatever its case or the spaces
  // around it: `/goal Pause` from an autocorrecting keyboard pauses the goal
  // instead of replacing it with a new one named "Pause". An objective that
  // only starts with such a word stays an objective.
  const control = args.trim().toLowerCase();
  if (!control || control === "status") return { action: "status" };
  if (control === "pause" || control === "resume" || control === "clear")
    return { action: control };
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

/**
 * The JSON of the `tag` block that ends the reply, as the protocol asks
 * ("End your reply with a fenced ... JSON object").
 *
 * The block is found by the shared reader, like every other protocol block:
 * the last one the reply shows as its own, closed, with nothing but blank
 * space after it. It used to be the reply's last lines, spelled exactly, so
 * a state block written with tildes, indented or with trailing blanks was
 * shown and not read, and one inside an unclosed four-backtick block was
 * read though the transcript showed only that block.
 */
export function finalStateFence(
  text: string,
  tag: string,
): Record<string, unknown> | null {
  const block = protocolBlocks(text, tag).at(-1);
  if (!block?.closed || text.slice(block.end).trim()) return null;
  try {
    const value = JSON.parse(text.slice(block.bodyStart, block.bodyEnd));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}
