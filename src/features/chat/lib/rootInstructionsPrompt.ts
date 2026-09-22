/**
 * Operator-authored Markdown in the Distill root, formatted for prompts.
 *
 * Five files, two delivery paths: `prompt.md` and `security-posture.md` ride
 * in the ACP handoff after the app defaults; `user.md`, `lore.md` and the
 * global research index ride inside `operatorProtocols` so a wave executor
 * never sees the operator's record (`LAWS/MEMORY.md`).
 *
 * Pointers, not content, for lore and research: same trade-off as the
 * project wiki. Missing or blank files produce no block at all — an empty
 * tag would read as "the operator wrote nothing" and invite the model to
 * fill it.
 */

import {
  getDistillRoot,
  readDistillInstructions,
} from "@/shared/api/distillStore";

export const ROOT_PROMPT_DOCUMENT = "prompt.md";
export const ROOT_SECURITY_POSTURE_DOCUMENT = "security-posture.md";
export const ROOT_USER_DOCUMENT = "user.md";
export const ROOT_LORE_DOCUMENT = "lore.md";
export const ROOT_RESEARCH_INDEX_DOCUMENT = "research/index.md";

const ROOT_INSTRUCTION_PATHS = [
  ROOT_PROMPT_DOCUMENT,
  ROOT_SECURITY_POSTURE_DOCUMENT,
  ROOT_USER_DOCUMENT,
  ROOT_LORE_DOCUMENT,
  ROOT_RESEARCH_INDEX_DOCUMENT,
] as const;

export type RootInstructionPath = (typeof ROOT_INSTRUCTION_PATHS)[number];

export type RootInstructionContents = Record<string, string | null>;

const OPERATOR_INSTRUCTIONS_LEAD =
  "These files in the operator's Distill folder apply to every chat; treat them as standing instructions that outrank the app defaults above";

function joinRootPath(root: string, relative: string): string {
  const base = root.replace(/[/\\]+$/, "");
  const separator = root.includes("\\") ? "\\" : "/";
  const rel = relative.split(/[/\\]/).join(separator);
  return `${base}${separator}${rel}`;
}

function escapeClosingTag(tag: string, value: string): string {
  return value.replace(new RegExp(`</${tag}>`, "gi"), `<\\/${tag}>`);
}

function presentText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

let cachedRootPath: string | undefined;
let cachedContents: RootInstructionContents = {};
let inFlight: Promise<void> | null = null;

function operatorInstructionsFrom(
  root: string,
  contents: RootInstructionContents,
): string | undefined {
  const sections: string[] = [];
  for (const relative of [
    ROOT_PROMPT_DOCUMENT,
    ROOT_SECURITY_POSTURE_DOCUMENT,
  ] as const) {
    const content = presentText(contents[relative]);
    if (!content) continue;
    sections.push(
      [
        `## ${escapeClosingTag("operator-instructions", joinRootPath(root, relative))}`,
        "",
        escapeClosingTag("operator-instructions", content),
      ].join("\n"),
    );
  }
  if (sections.length === 0) return undefined;
  return [
    "<operator-instructions>",
    OPERATOR_INSTRUCTIONS_LEAD,
    "",
    ...sections,
    "</operator-instructions>",
  ].join("\n");
}

function operatorProfileFrom(
  root: string,
  contents: RootInstructionContents,
): string | undefined {
  const content = presentText(contents[ROOT_USER_DOCUMENT]);
  if (!content) return undefined;
  const userPath = joinRootPath(root, ROOT_USER_DOCUMENT);
  return [
    "<operator-profile>",
    `This is what the operator wrote about themselves and how they want to work together. It lives at ${userPath} and is theirs to edit; propose changes through the memory protocol, never write this file`,
    "",
    escapeClosingTag("operator-profile", content),
    "</operator-profile>",
  ].join("\n");
}

function lorePointerFrom(
  root: string,
  contents: RootInstructionContents,
): string | undefined {
  if (!presentText(contents[ROOT_LORE_DOCUMENT])) return undefined;
  const lorePath = joinRootPath(root, ROOT_LORE_DOCUMENT);
  return `The operator keeps a map of past joint work at ${lorePath}: projects, decisions, results, lessons. Read it when the task touches earlier work. Only the conductor loop updates it.`;
}

function researchPointerFrom(
  root: string,
  contents: RootInstructionContents,
): string | undefined {
  if (!presentText(contents[ROOT_RESEARCH_INDEX_DOCUMENT])) return undefined;
  const researchDir = `${joinRootPath(root, "research")}${root.includes("\\") ? "\\" : "/"}`;
  const researchIndex = joinRootPath(root, ROOT_RESEARCH_INDEX_DOCUMENT);
  return `Decision records live under ${researchDir}. Read ${researchIndex} before revisiting a settled question.`;
}

async function loadRootInstructions(): Promise<void> {
  try {
    if (!cachedRootPath) {
      const root = (await getDistillRoot())?.root?.trim();
      // A miss is not cached: the first chat can mount in the startup
      // window where getDistillRoot still returns null, and sticking that
      // would hide the five files for the rest of the run.
      if (root) cachedRootPath = root;
    }
    if (!cachedRootPath) {
      cachedContents = {};
      return;
    }
    cachedContents = await readDistillInstructions([...ROOT_INSTRUCTION_PATHS]);
  } catch (error) {
    console.error("Failed to read Distill root instructions:", error);
    cachedContents = Object.fromEntries(
      ROOT_INSTRUCTION_PATHS.map((path) => [path, null]),
    );
  }
}

/**
 * One IPC for all five files. Concurrent callers share the in-flight read.
 * A resolved root path is kept for the process; a miss is asked again.
 */
export function refreshRootInstructions(): Promise<void> {
  if (!inFlight) {
    inFlight = loadRootInstructions().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** What the last refresh learned. Empty before the first refresh settles. */
export function knownRootInstructions(): RootInstructionContents {
  return cachedContents;
}

export function formatOperatorInstructionsPrompt(): string | undefined {
  const root = cachedRootPath?.trim();
  if (!root) return undefined;
  return operatorInstructionsFrom(root, cachedContents);
}

export function formatOperatorProfilePrompt(): string | undefined {
  const root = cachedRootPath?.trim();
  if (!root) return undefined;
  return operatorProfileFrom(root, cachedContents);
}

export function formatLorePointerPrompt(): string | undefined {
  const root = cachedRootPath?.trim();
  if (!root) return undefined;
  return lorePointerFrom(root, cachedContents);
}

export function formatResearchPointerPrompt(): string | undefined {
  const root = cachedRootPath?.trim();
  if (!root) return undefined;
  return researchPointerFrom(root, cachedContents);
}

/** Clears cached root, contents and in-flight work. Tests only. */
export function resetRootInstructionsForTests(): void {
  cachedRootPath = undefined;
  cachedContents = {};
  inFlight = null;
}
