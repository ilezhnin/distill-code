import { describe, expect, it } from "vitest";
import type { ModelOption } from "../../types";
import { hideAliasTwins, isModelAlias } from "../modelAliases";

function row(id: string, displayName: string): ModelOption {
  return { id, name: displayName, displayName, providerId: "claude-acp" };
}

const defaultRow = row("default", "Opus 5");
const opusRow = row("opus[1m]", "Opus 5");
const sonnetRow = row("sonnet", "Sonnet 5");

describe("isModelAlias", () => {
  it("knows the ids that stand for whatever the CLI resolves", () => {
    expect(isModelAlias("default")).toBe(true);
    expect(isModelAlias("current")).toBe(true);
    expect(isModelAlias("opus[1m]")).toBe(false);
    expect(isModelAlias(null)).toBe(false);
  });
});

describe("hideAliasTwins", () => {
  it("hides the default alias behind the model it resolves to", () => {
    expect(hideAliasTwins([defaultRow, opusRow, sonnetRow], "sonnet")).toEqual([
      opusRow,
      sonnetRow,
    ]);
  });

  it("keeps the default row, not its twin, while the session runs on it", () => {
    expect(hideAliasTwins([defaultRow, opusRow, sonnetRow], "default")).toEqual(
      [defaultRow, sonnetRow],
    );
  });

  it("keeps a default row that has no twin", () => {
    const bareDefault = row("default", "Default");

    expect(hideAliasTwins([bareDefault, sonnetRow], null)).toEqual([
      bareDefault,
      sonnetRow,
    ]);
  });

  it("pairs the two rows by the twin the harness names, whatever they read", () => {
    // The harness states the pairing now, so the alias keeps its own name
    // without the list naming that model twice.
    const namedDefault = {
      ...row("default", "Default (recommended)"),
      aliasOf: "opus[1m]",
    };

    expect(
      hideAliasTwins([namedDefault, opusRow, sonnetRow], "sonnet"),
    ).toEqual([opusRow, sonnetRow]);
    expect(
      hideAliasTwins([namedDefault, opusRow, sonnetRow], "default"),
    ).toEqual([namedDefault, sonnetRow]);
  });

  it("keeps an alias whose twin the harness does not list", () => {
    const namedDefault = {
      ...row("default", "Default (recommended)"),
      aliasOf: "opus[1m]",
    };

    expect(hideAliasTwins([namedDefault, sonnetRow], null)).toEqual([
      namedDefault,
      sonnetRow,
    ]);
  });

  it("hides a twin the harness names even when neither row is an alias id", () => {
    const latest = {
      ...row("sonnet-latest", "Sonnet latest"),
      aliasOf: "sonnet",
    };

    expect(hideAliasTwins([latest, sonnetRow], null)).toEqual([sonnetRow]);
    expect(hideAliasTwins([latest, sonnetRow], "sonnet-latest")).toEqual([
      latest,
    ]);
  });
});
