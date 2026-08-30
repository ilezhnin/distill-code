import { describe, expect, it } from "vitest";

import {
  MODEL_CLASS_BY_AGENT_SLUG,
  MODEL_PREFERENCE_CLASSES,
  isModelPreferenceClassId,
  modelPreferenceClassForPersona,
  resolveRankedModel,
  type RankableModel,
  type RankedModelResolutionInput,
} from "./modelRanking";

const CLAUDE_MODELS: RankableModel[] = [
  { id: "claude-opus-5", displayName: "Claude Opus 5" },
  { id: "claude-fable-5", displayName: "Claude Fable 5" },
];
const CODEX_MODELS: RankableModel[] = [
  { id: "gpt-5-codex-sol", displayName: "Codex Sol" },
];
const GROK_MODELS: RankableModel[] = [
  { id: "grok-4-6-heavy", displayName: "Grok 4.6 Heavy" },
  { id: "grok-4-6", displayName: "Grok 4.6" },
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
  it("picks the top preference when everything is available", () => {
    const result = resolveRankedModel("frontend-ui", input());
    expect(result.choice?.label).toBe("Opus 5");
    expect(result.choice?.harnessId).toBe("claude-acp");
    expect(result.choice?.model.id).toBe("claude-opus-5");
    expect(result.choice?.rankIndex).toBe(0);
    expect(result.skipped).toEqual([]);
  });

  it("falls through a platform at its usage limit, and says so", () => {
    const result = resolveRankedModel(
      "one-shot",
      input({
        platformLimitState: (platform) =>
          platform === "claude-acp" ? "at-limit" : "clear",
      }),
    );
    // one-shot: Fable → Sol → Opus → Grok; both claude candidates are gated.
    expect(result.choice?.label).toBe("Codex Sol");
    expect(result.choice?.rankIndex).toBe(1);
    expect(result.skipped).toEqual([{ label: "Fable 5", reason: "at-limit" }]);
  });

  it("keeps Opus when only Fable's own weekly window is spent", () => {
    // The operator's case, verbatim: "if Fable is in cooldown and the next
    // choice is Opus and the Anthropic account still allows it, take Opus".
    // Both live on claude-acp, so a per-platform verdict locked Opus out too.
    const result = resolveRankedModel(
      "one-shot",
      input({
        platformLimitState: (platform, scopedWindow) =>
          platform === "claude-acp" && scopedWindow === "fableWeekly"
            ? "at-limit"
            : "clear",
      }),
    );

    // one-shot: Fable → Sol → Opus → Grok. Fable is out on its own window;
    // Sol is next and still clear, so it wins — but Opus was never gated.
    expect(result.choice?.label).toBe("Codex Sol");
    expect(result.skipped).toEqual([{ label: "Fable 5", reason: "at-limit" }]);
  });

  it("passes over a platform that is merely close to its limit", () => {
    const result = resolveRankedModel(
      "frontend-ui",
      input({
        platformLimitState: (platform) =>
          platform === "claude-acp" ? "near-limit" : "clear",
      }),
    );

    // frontend-ui: Opus → Fable → Sol. Both claude candidates are near their
    // limit, so the work goes to Sol rather than being cut off mid-flight.
    expect(result.choice?.label).toBe("Codex Sol");
    expect(result.choice?.nearLimit).toBeUndefined();
    expect(result.skipped).toEqual([
      { label: "Opus 5", reason: "near-limit" },
      { label: "Fable 5", reason: "near-limit" },
    ]);
  });

  it("takes a near-limit model rather than nothing, and says it settled", () => {
    const result = resolveRankedModel(
      "frontend-ui",
      input({ platformLimitState: () => "near-limit" }),
    );

    // Every candidate is close to its limit. Falling through to the caller's
    // untargeted default would be worse than the model the operator ranked.
    expect(result.choice?.label).toBe("Opus 5");
    expect(result.choice?.nearLimit).toBe(true);
    // The skips reported are the strict pass — what it would have used.
    expect(result.skipped.map((skip) => skip.reason)).toEqual([
      "near-limit",
      "near-limit",
      "near-limit",
    ]);
  });

  it("carries the effort the ranking asks for", () => {
    const result = resolveRankedModel("frontend-ui", input());
    expect(result.choice?.effort).toBe("xhigh");
  });

  it("falls through a model that is not installed", () => {
    const result = resolveRankedModel(
      "coding-simple",
      input({
        modelsForPlatform: (platform) =>
          platform === "claude-acp" ? CLAUDE_MODELS : [],
      }),
    );
    // coding-simple: Grok Heavy → Opus.
    expect(result.choice?.label).toBe("Opus 5");
    expect(result.skipped).toEqual([
      { label: "Grok 4.6 Heavy", reason: "not-installed" },
    ]);
  });

  it("matches Grok Heavy before plain Grok, never the other way", () => {
    const heavy = resolveRankedModel("coding-simple", input());
    expect(heavy.choice?.model.id).toBe("grok-4-6-heavy");
    const light = resolveRankedModel("testing-light", input());
    // testing-light starts at plain Grok; the first grok match wins.
    expect(light.choice?.harnessId).toBe("grok-acp");
  });

  it("prefers the effort-tier variant the candidate asks for", () => {
    // Codex serves every tier as its own id, ascending — first-match used to
    // hand an xhigh candidate the [low] variant (L1, 2026-08-28).
    const tiers: RankableModel[] = [
      { id: "gpt-5.6-sol[low]", displayName: "GPT 5.6 Sol[low]" },
      { id: "gpt-5.6-sol[medium]", displayName: "GPT 5.6 Sol[medium]" },
      { id: "gpt-5.6-sol[xhigh]", displayName: "GPT 5.6 Sol[xhigh]" },
    ];
    const result = resolveRankedModel(
      "coding-complex",
      input({
        modelsForPlatform: (platform) =>
          platform === "codex-acp" ? tiers : [],
      }),
    );
    // coding-complex: Fable → Sol; Fable is not installed here.
    expect(result.choice?.label).toBe("Codex Sol");
    expect(result.choice?.model.id).toBe("gpt-5.6-sol[xhigh]");
  });

  it("keeps the first match when no variant embeds the asked effort", () => {
    const tiers: RankableModel[] = [
      { id: "gpt-5.6-sol[low]", displayName: "GPT 5.6 Sol[low]" },
      { id: "gpt-5.6-sol[ultra]", displayName: "GPT 5.6 Sol[ultra]" },
    ];
    const result = resolveRankedModel(
      "coding-complex",
      input({
        modelsForPlatform: (platform) =>
          platform === "codex-acp" ? tiers : [],
      }),
    );
    // The preference cannot be honoured, so behavior stays what it was —
    // the first advertised match — rather than resolving to nothing.
    expect(result.choice?.model.id).toBe("gpt-5.6-sol[low]");
  });

  it("searches every harness for a platformless candidate", () => {
    const result = resolveRankedModel(
      "testing-light",
      input({
        modelsForPlatform: () => [],
        allModels: () => [
          { harnessId: "goose", model: { id: "tera-1", displayName: "Tera" } },
        ],
      }),
    );
    expect(result.choice?.label).toBe("Tera");
    expect(result.choice?.harnessId).toBe("goose");
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
  it("prefers the persona's own modelRanking property", () => {
    expect(
      modelPreferenceClassForPersona({
        modelRanking: "testing-heavy",
        displayName: "Producer",
      }),
    ).toBe("testing-heavy");
  });

  it("falls back to the bundled slug, normalizing spaces", () => {
    expect(modelPreferenceClassForPersona({ displayName: "Producer" })).toBe(
      "one-shot",
    );
    expect(
      modelPreferenceClassForPersona({ displayName: "Unity Worker" }),
    ).toBe("coding-complex");
  });

  it("resolves bundled agents whose display name differs from the file stem", () => {
    // The lookup slugs a display name, so "Submitter" (file: pr-submitter.md)
    // used to fall through the map and get no ranking at all.
    expect(modelPreferenceClassForPersona({ displayName: "Submitter" })).toBe(
      "coding-simple",
    );
    expect(
      modelPreferenceClassForPersona({ displayName: "Asset Integrator" }),
    ).toBe("coding-simple");
    expect(modelPreferenceClassForPersona({ displayName: "Test Runner" })).toBe(
      "testing-light",
    );
    // The companion agents (calibration 2026-08-30): conversations with a
    // strong generalist, so every one of them resolves to one-shot — before
    // this they had no class at all and silently took whatever model the
    // session held.
    for (const displayName of [
      "Agt. Builder",
      "Distill",
      "Choosey",
      "Copycat",
      "Pushback",
      "Wildcard",
    ]) {
      expect(modelPreferenceClassForPersona({ displayName })).toBe("one-shot");
    }
  });

  it("gives an unknown agent no ranking at all", () => {
    expect(
      modelPreferenceClassForPersona({ displayName: "My Custom Agent" }),
    ).toBeUndefined();
    expect(
      modelPreferenceClassForPersona({ modelRanking: "bogus-class" }),
    ).toBeUndefined();
  });

  it("keeps every slug mapping pointed at a real class", () => {
    for (const classId of Object.values(MODEL_CLASS_BY_AGENT_SLUG)) {
      expect(isModelPreferenceClassId(classId)).toBe(true);
    }
  });
});
