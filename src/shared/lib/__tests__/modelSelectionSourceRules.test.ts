import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source rules for the four model selections (provider, model, reasoning
 * effort, fast mode). Distill used to fold an effort into a model id
 * (`gpt-5.6-sol[xhigh]`) in three layers at once; each of these rules keeps
 * one way back to that closed. The Rust side has its own copy in the agent
 * host's router (`source_rules`), which `cargo test` runs.
 */

const ROOT = process.cwd();
const THIS_FILE = "src/shared/lib/__tests__/modelSelectionSourceRules.test.ts";
/** The app's one reader of folded ids. It has no compose function either. */
const FOLDED_ID_READER = "src/shared/lib/foldedModelId.ts";

function sourceFiles(dir: string, extensions: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path, extensions);
    }
    return extensions.test(entry.name)
      ? [relative(ROOT, path).replaceAll("\\", "/")]
      : [];
  });
}

function offendingLines(
  files: readonly string[],
  matches: (line: string) => boolean,
): string[] {
  return files.flatMap((file) =>
    readFileSync(resolve(ROOT, file), "utf8")
      .split(/\r?\n/)
      .flatMap((line, index) =>
        matches(line) ? [`${file}:${index + 1}`] : [],
      ),
  );
}

function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

describe("model selection source rules", () => {
  const files = sourceFiles(resolve(ROOT, "src"), /\.(ts|tsx|json)$/).filter(
    (file) => file !== THIS_FILE,
  );

  it("names none of the retired folded-effort identifiers anywhere in src", () => {
    // The synthetic `model_reasoning` config, the goose-era `thinking_effort`
    // ladder and the never-read `thinkingEffort` preference, and the helpers
    // that collapsed and re-composed folded ids. Built from parts so this file
    // does not match itself.
    const retired = [
      ["compose", "EmbeddedReasoning"],
      ["collapse", "EmbeddedReasoning"],
      ["model_", "reasoning"],
      ["thinking", "Effort"],
      ["thinking_", "effort"],
    ].map((parts) => parts.join(""));

    expect(
      offendingLines(files, (line) =>
        retired.some((name) => line.includes(name)),
      ),
    ).toEqual([]);
  });

  it("composes a model id with a bracketed effort nowhere, not even in the folded-id reader", () => {
    // `${base}[${effort}]` and `base + "[" + effort + "]"`. The legacy reader
    // is listed only to say that it, too, must stay a reader.
    const templateFold = /\$\{[^}]*\}\[\$\{[^}]*\}\]/;
    const concatenatedFold = /\+\s*["'`]\[["'`]\s*\+/;

    const code = files.filter((file) => /\.(ts|tsx)$/.test(file));
    expect(code).toContain(FOLDED_ID_READER);
    expect(
      offendingLines(
        code,
        (line) =>
          !isComment(line) &&
          (templateFold.test(line) || concatenatedFold.test(line)),
      ),
    ).toEqual([]);
  });

  it.each([
    "en",
    "es",
  ])("has retired the old picker's toolbar keys in %s and kept the unrelated message viewMore", (locale) => {
    const chat = JSON.parse(
      readFileSync(
        resolve(ROOT, "src/shared/i18n/locales", locale, "chat.json"),
        "utf8",
      ),
    ) as {
      toolbar: Record<string, unknown>;
      message: Record<string, unknown>;
    };

    expect(chat.toolbar).not.toHaveProperty("olderModels");
    expect(chat.toolbar).not.toHaveProperty("viewMore");
    expect(chat.message.viewMore).toEqual(expect.any(String));
  });

  it("uses every key the model, effort and fast controls ship with", () => {
    const code = files
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .map((file) => readFileSync(resolve(ROOT, file), "utf8"))
      .join("\n");
    const keys = [
      "toolbar.moreModels",
      "toolbar.backToModels",
      "toolbar.modelNeedsIdleSession",
      "toolbar.effortUnavailable",
      "toolbar.fastUnavailable",
      "toolbar.effortControlUnavailable",
      "toolbar.fastMode",
      "toolbar.fastModeEnable",
      "toolbar.fastModeDisable",
      "toolbar.reasoningEffort",
      "toolbar.reasoningEffortCurrent",
      "toolbar.effort",
      "toolbar.effortFaster",
      "toolbar.effortSmarter",
      "ranking.effortNotOffered",
      "ranking.fast",
      "ranking.fastAria",
      "ranking.previewEffortUnavailable",
      "ranking.previewFastUnavailable",
      "conductor.chipFast",
    ];

    // Whole keys only: `toolbar.effort` must not pass on the strength of
    // `toolbar.effortUnavailable`.
    const used = (key: string) =>
      new RegExp(`["'\`]${key.replaceAll(".", "\\.")}["'\`]`).test(code);
    expect(keys.filter((key) => !used(key))).toEqual([]);
  });
});
