import { describe, expect, it } from "vitest";

import {
  MODEL_PREFERENCE_CLASSES,
  isModelPreferenceClassId,
  modelPreferenceClassForPersona,
  resolveRankedModel,
  type RankableModel,
  type RankedModelResolutionInput,
} from "./modelRanking";

const CLAUDE_MODELS: RankableModel[] = [
  { id: "claude-opus-5", displayName: "Claude Opus 5" },
  { id: "claude-fable-5-1", displayName: "Claude Fable 5.1" },
];
const CODEX_MODELS: RankableModel[] = [
  { id: "codex-astra", displayName: "Codex Astra" },
  { id: "gpt-5-codex-sol", displayName: "Codex Sol" },
];
const GROK_MODELS: RankableModel[] = [
  { id: "grok-4.7", displayName: "Grok 4.7" },
  { id: "grok-4.6", displayName: "Grok 4.6" },
];

function input(
  overrides: Partial<RankedModelResolutionInput> = {},
): RankedModelResolutionInput {
  const byPlatform: Record<string, RankableModel[]> = {
    "claude-acp": CLAUDE_MODELS,
    "codex-acp": CODEX_MODELS,
    "grok-acp": GROK_MODELS,
  };
  return {
    modelsForPlatform: (platform) => byPlatform[platform] ?? [],
    allModels: () =>
      Object.entries(byPlatform).flatMap(([harnessId, models]) =>
        models.map((model) => ({ harnessId, model })),
      ),
    platformLimitState: () => "clear",
    ...overrides,
  };
}

describe("resolveRankedModel", () => {
  it("falls through a platform at its usage limit, and says so", () => {
    const result = resolveRankedModel(
      "one-shot",
      input({
        platformLimitState: (platform) =>
          platform === "grok-acp" ? "clear" : "at-limit",
      }),
    );
    // one-shot: Astra → Fable 5.1 → Opus 5 → Grok 4.7; everything but Grok
    // is gated here.
    expect(result.choice?.label).toBe("Grok 4.7");
    expect(result.choice?.rankIndex).toBe(3);
    expect(result.skipped).toEqual([
      { label: "Astra", reason: "at-limit" },
      { label: "Fable 5.1", reason: "at-limit" },
      { label: "Opus 5", reason: "at-limit" },
    ]);
  });

  it("takes a near-limit model rather than nothing, and says it settled", () => {
    const result = resolveRankedModel(
      "frontend-ui",
      input({ platformLimitState: () => "near-limit" }),
    );

    // Every candidate is close to its limit. Falling through to the caller's
    // untargeted default would be worse than the model the operator ranked.
    expect(result.choice?.label).toBe("Fable 5.1");
    expect(result.choice?.nearLimit).toBe(true);
    // The skips reported are the strict pass — what it would have used.
    expect(result.skipped.map((skip) => skip.reason)).toEqual([
      "near-limit",
      "near-limit",
      "near-limit",
    ]);
  });

  it("still picks a model that lacks the ranked effort and says the effort is not applied", () => {
    // Fail-open: skipping the candidate would disable the ranking whenever a
    // model's efforts differ from the profile's; the caller shows what runs.
    const claude: RankableModel[] = [
      {
        id: "claude-opus-4-6",
        displayName: "Claude Opus 5",
        efforts: [
          { id: "low", name: "Low" },
          { id: "high", name: "High" },
          { id: "max", name: "Max" },
        ],
        defaultEffort: "high",
      },
    ];
    const result = resolveRankedModel(
      "coding-complex",
      input({
        modelsForPlatform: (platform) =>
          platform === "claude-acp" ? claude : [],
      }),
    );
    expect(result.choice?.label).toBe("Opus 5");
    expect(result.choice?.model.id).toBe("claude-opus-4-6");
    expect(result.choice?.effort).toBe("xhigh");
    expect(result.choice?.effortApplied).toBe(false);
  });

  it("names the model rather than the default alias labeled with it", () => {
    // Claude Code lists "default" first and labels it with the model it
    // resolves to today, so it matches the Opus needles too.
    const claudeRows: RankableModel[] = [
      { id: "default", displayName: "Opus 5" },
      { id: "opus[1m]", displayName: "Opus 5" },
    ];
    const onlyClaude = (models: RankableModel[]) =>
      input({
        modelsForPlatform: (platform) =>
          platform === "claude-acp" ? models : [],
      });

    // coding-complex: Astra → Fable 5.1 → Opus 5; only Opus is installed.
    expect(
      resolveRankedModel("coding-complex", onlyClaude(claudeRows)).choice?.model
        .id,
    ).toBe("opus[1m]");
    // With nothing but the alias, the alias still serves.
    expect(
      resolveRankedModel("coding-complex", onlyClaude([claudeRows[0]])).choice
        ?.model.id,
    ).toBe("default");
  });

  it("returns no choice when nothing in the ranking is usable", () => {
    const result = resolveRankedModel(
      "coding-complex",
      input({ modelsForPlatform: () => [], allModels: () => [] }),
    );
    expect(result.choice).toBeUndefined();
    expect(result.skipped.length).toBe(
      MODEL_PREFERENCE_CLASSES["coding-complex"].ranking.length,
    );
  });
});

describe("modelPreferenceClassForPersona", () => {
  it("refuses an Object.prototype member as a class id", () => {
    for (const value of ["constructor", "toString", "__proto__", "valueOf"]) {
      expect(isModelPreferenceClassId(value)).toBe(false);
      expect(
        modelPreferenceClassForPersona({ modelRanking: value }),
      ).toBeUndefined();
    }
  });
});
