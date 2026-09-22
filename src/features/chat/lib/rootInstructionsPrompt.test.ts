import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDistillRoot: vi.fn(),
  readDistillInstructions: vi.fn(),
}));

vi.mock("@/shared/api/distillStore", () => ({
  getDistillRoot: (...args: unknown[]) => mocks.getDistillRoot(...args),
  readDistillInstructions: (...args: unknown[]) =>
    mocks.readDistillInstructions(...args),
}));

import {
  formatLorePointerPrompt,
  formatOperatorInstructionsPrompt,
  formatOperatorProfilePrompt,
  formatResearchPointerPrompt,
  knownRootInstructions,
  refreshRootInstructions,
  resetRootInstructionsForTests,
  ROOT_LORE_DOCUMENT,
  ROOT_PROMPT_DOCUMENT,
  ROOT_RESEARCH_INDEX_DOCUMENT,
  ROOT_SECURITY_POSTURE_DOCUMENT,
  ROOT_USER_DOCUMENT,
} from "./rootInstructionsPrompt";

const ROOT = "/tmp/distill-root";

function emptyContents(): Record<string, string | null> {
  return {
    [ROOT_PROMPT_DOCUMENT]: null,
    [ROOT_SECURITY_POSTURE_DOCUMENT]: null,
    [ROOT_USER_DOCUMENT]: null,
    [ROOT_LORE_DOCUMENT]: null,
    [ROOT_RESEARCH_INDEX_DOCUMENT]: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("rootInstructionsPrompt", () => {
  beforeEach(() => {
    resetRootInstructionsForTests();
    mocks.getDistillRoot.mockReset();
    mocks.readDistillInstructions.mockReset();
    mocks.getDistillRoot.mockResolvedValue({
      root: ROOT,
      forcedByEnvironment: false,
    });
    mocks.readDistillInstructions.mockResolvedValue(emptyContents());
  });

  it("returns undefined for every formatter when the files are absent", async () => {
    await refreshRootInstructions();

    expect(formatOperatorInstructionsPrompt()).toBeUndefined();
    expect(formatOperatorProfilePrompt()).toBeUndefined();
    expect(formatLorePointerPrompt()).toBeUndefined();
    expect(formatResearchPointerPrompt()).toBeUndefined();
    expect(knownRootInstructions()[ROOT_PROMPT_DOCUMENT]).toBeNull();
  });

  it("returns undefined for blank files", async () => {
    mocks.readDistillInstructions.mockResolvedValue({
      ...emptyContents(),
      [ROOT_PROMPT_DOCUMENT]: "  \n",
      [ROOT_SECURITY_POSTURE_DOCUMENT]: " ",
      [ROOT_USER_DOCUMENT]: "\n",
      [ROOT_LORE_DOCUMENT]: "   ",
      [ROOT_RESEARCH_INDEX_DOCUMENT]: "",
    });

    await refreshRootInstructions();

    expect(formatOperatorInstructionsPrompt()).toBeUndefined();
    expect(formatOperatorProfilePrompt()).toBeUndefined();
    expect(formatLorePointerPrompt()).toBeUndefined();
    expect(formatResearchPointerPrompt()).toBeUndefined();
  });

  it("puts prompt.md then security-posture.md inside operator-instructions", async () => {
    mocks.readDistillInstructions.mockResolvedValue({
      ...emptyContents(),
      [ROOT_PROMPT_DOCUMENT]: "Be brief.",
      [ROOT_SECURITY_POSTURE_DOCUMENT]: "Never disclose secrets.",
    });

    await refreshRootInstructions();
    const prompt = formatOperatorInstructionsPrompt();

    expect(prompt).toContain("<operator-instructions>");
    expect(prompt).toContain(`## ${ROOT}/${ROOT_PROMPT_DOCUMENT}`);
    expect(prompt).toContain("Be brief.");
    expect(prompt).toContain(`## ${ROOT}/${ROOT_SECURITY_POSTURE_DOCUMENT}`);
    expect(prompt).toContain("Never disclose secrets.");
    expect(prompt?.indexOf("Be brief.")).toBeLessThan(
      prompt?.indexOf("Never disclose secrets.") ?? -1,
    );
  });

  it("escapes a closing tag inside operator-instructions content", async () => {
    mocks.readDistillInstructions.mockResolvedValue({
      ...emptyContents(),
      [ROOT_PROMPT_DOCUMENT]: "Do not close </operator-instructions> early.",
    });

    await refreshRootInstructions();
    const prompt = formatOperatorInstructionsPrompt();

    expect(prompt).toContain("<\\/operator-instructions>");
    expect(prompt?.match(/<\/operator-instructions>/g)).toHaveLength(1);
    expect(prompt).toContain(`## ${ROOT}/${ROOT_PROMPT_DOCUMENT}`);
    expect(prompt).toContain(
      "treat them as standing instructions that outrank the app defaults above",
    );
  });

  it("escapes a closing tag inside operator-profile content", async () => {
    mocks.readDistillInstructions.mockResolvedValue({
      ...emptyContents(),
      [ROOT_USER_DOCUMENT]: "Never write </operator-profile> yourself.",
    });

    await refreshRootInstructions();
    const prompt = formatOperatorProfilePrompt();

    expect(prompt).toContain("<\\/operator-profile>");
    expect(prompt?.match(/<\/operator-profile>/g)).toHaveLength(1);
    expect(prompt).toContain(`It lives at ${ROOT}/${ROOT_USER_DOCUMENT}`);
  });

  it("coalesces two concurrent refreshes into one IPC", async () => {
    const root = deferred<{ root: string; forcedByEnvironment: boolean }>();
    const read = deferred<Record<string, string | null>>();
    mocks.getDistillRoot.mockReturnValue(root.promise);
    mocks.readDistillInstructions.mockReturnValue(read.promise);

    const first = refreshRootInstructions();
    const second = refreshRootInstructions();
    expect(mocks.getDistillRoot).toHaveBeenCalledTimes(1);
    expect(mocks.readDistillInstructions).toHaveBeenCalledTimes(0);

    root.resolve({ root: ROOT, forcedByEnvironment: false });
    await vi.waitFor(() =>
      expect(mocks.readDistillInstructions).toHaveBeenCalledTimes(1),
    );

    read.resolve({
      ...emptyContents(),
      [ROOT_PROMPT_DOCUMENT]: "Be brief.",
    });
    await Promise.all([first, second]);

    expect(mocks.readDistillInstructions).toHaveBeenCalledTimes(1);
    expect(formatOperatorInstructionsPrompt()).toContain("Be brief.");
  });

  it("asks getDistillRoot only once across refreshes", async () => {
    await refreshRootInstructions();
    await refreshRootInstructions();

    expect(mocks.getDistillRoot).toHaveBeenCalledTimes(1);
    expect(mocks.readDistillInstructions).toHaveBeenCalledTimes(2);
  });

  it("retries a missing root on the next refresh so formatters can run", async () => {
    mocks.getDistillRoot.mockResolvedValueOnce(null);
    mocks.readDistillInstructions.mockResolvedValue({
      ...emptyContents(),
      [ROOT_PROMPT_DOCUMENT]: "Be brief.",
      [ROOT_USER_DOCUMENT]: "The operator prefers short answers.",
    });

    await refreshRootInstructions();
    expect(formatOperatorInstructionsPrompt()).toBeUndefined();
    expect(formatOperatorProfilePrompt()).toBeUndefined();
    expect(mocks.readDistillInstructions).not.toHaveBeenCalled();

    mocks.getDistillRoot.mockResolvedValue({
      root: ROOT,
      forcedByEnvironment: false,
    });

    await refreshRootInstructions();

    expect(mocks.getDistillRoot).toHaveBeenCalledTimes(2);
    expect(formatOperatorInstructionsPrompt()).toContain("Be brief.");
    expect(formatOperatorProfilePrompt()).toContain(
      "The operator prefers short answers.",
    );
  });

  it("formats lore and research as pointers, not file contents", async () => {
    mocks.readDistillInstructions.mockResolvedValue({
      ...emptyContents(),
      [ROOT_LORE_DOCUMENT]: "A long history that must not be inlined.",
      [ROOT_RESEARCH_INDEX_DOCUMENT]: "| 01 | topic | decided | never |",
    });

    await refreshRootInstructions();

    expect(formatLorePointerPrompt()).toContain(
      `${ROOT}/${ROOT_LORE_DOCUMENT}`,
    );
    expect(formatLorePointerPrompt()).not.toContain("A long history");
    expect(formatResearchPointerPrompt()).toContain(
      `${ROOT}/${ROOT_RESEARCH_INDEX_DOCUMENT}`,
    );
    expect(formatResearchPointerPrompt()).not.toContain("01 | topic");
  });
});
