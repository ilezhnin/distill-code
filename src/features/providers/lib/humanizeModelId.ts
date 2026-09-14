import { CLAUDE_FAMILIES } from "@/features/chat/lib/modelGenerations";
import type { ProviderInventoryModel } from "@/shared/api/hostTypes";

const NUMERIC = /^\d+$/;

const KNOWN_CASINGS: Record<string, string> = {
  gpt: "GPT",
  chatgpt: "ChatGPT",
  aws: "AWS",
  openai: "OpenAI",
};

/** `claude-fable-5-1[1m]`, `claude-haiku-4-5-20251001`: family, major, minor. */
const CLAUDE_MODEL_ID = new RegExp(
  `^claude-(${CLAUDE_FAMILIES})-(\\d+)(?:-(\\d{1,2}))?(?:-\\d{8})?(?:\\[1m\\])?$`,
  "i",
);

/** Claude Code leads each model description with the model: "Opus 5 with 1M context · …". */
const CLAUDE_MODEL_DESCRIPTION = new RegExp(
  `^(${CLAUDE_FAMILIES}) (\\d+(?:\\.\\d+)?)(?![\\d.])`,
  "i",
);

function capitalize(token: string): string {
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

export function humanizeRawModelId(id: string): string {
  const stripped = id.startsWith("goose-") ? id.slice("goose-".length) : id;

  // Claude models read the way Claude Code names them ("Fable 5.1"), without
  // the vendor prefix or the context-window hint.
  const claude = stripped.match(CLAUDE_MODEL_ID);
  if (claude) {
    const [, family, major, minor] = claude;
    return `${capitalize(family)} ${minor ? `${major}.${minor}` : major}`;
  }

  const tokens = stripped.split("-").filter(Boolean);
  if (tokens.length === 0) return id;

  const segments: string[] = [];
  let numericRun: string[] = [];
  const flushNumeric = () => {
    if (numericRun.length > 0) {
      segments.push(numericRun.join("."));
      numericRun = [];
    }
  };

  for (const token of tokens) {
    if (NUMERIC.test(token)) {
      numericRun.push(token);
    } else {
      flushNumeric();
      const known = KNOWN_CASINGS[token.toLowerCase()];
      segments.push(known ?? capitalize(token));
    }
  }
  flushNumeric();

  const result = segments.join(" ");
  return result.length === 0 ? id : result;
}

/**
 * The label for a model a harness listed, in the order the host states it.
 *
 * 1. A Claude Code row names its model only in the description ("Opus 5 with
 *    1M context · …"), while its `name` is the alias the bridge lists it under
 *    ("Default (recommended)"). The description is the more specific of the
 *    host's two answers, and naming the alias row by the model it resolves to
 *    is also what lets `hideAliasTwins` pair it with its twin by label.
 * 2. Otherwise the row's own name, which is the harness's spelling
 *    ("GPT-5.6-Sol") and beats anything derived from the id.
 * 3. Only for a row the host did not name — or named with nothing but its id —
 *    the id itself, humanized. That fallback is what produced "GPT 5.6 Luna".
 */
export function harnessModelLabel(
  model: Pick<ProviderInventoryModel, "id" | "description"> &
    Partial<Pick<ProviderInventoryModel, "name">>,
): string {
  const described = model.description?.trim().match(CLAUDE_MODEL_DESCRIPTION);
  if (described) {
    return `${capitalize(described[1])} ${described[2]}`;
  }
  const named = model.name?.trim();
  return named && named !== model.id ? named : humanizeRawModelId(model.id);
}
