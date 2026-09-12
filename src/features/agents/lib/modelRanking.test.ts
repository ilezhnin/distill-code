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
  { id: "claude-fable-5-1", displayName: "Claude Fable 5.1" },
];
const CODEX_MODELS: RankableModel[] = [
  { id: "codex-astra", displayName: "Codex Astra" },
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

describe("the operator's profiles", () => {
  it("runs heavy engineering at xhigh throughout", () => {
    expect(
      MODEL_PREFERENCE_CLASSES["coding-complex"].ranking.map((candidate) => [
        candidate.label,
        candidate.effort,
      ]),
    ).toEqual([
      ["Astra", "xhigh"],
      ["Fable 5.1", "xhigh"],
      ["Opus 5", "xhigh"],
      ["Grok 4.6", "xhigh"],
    ]);
  });

  it("runs medium engineering at medium, Grok excepted", () => {
    // "the same but medium for everyone except Grok, Grok stays xhigh"
    // (2026-09-12): Grok is worth xhigh or nothing.
    expect(
      MODEL_PREFERENCE_CLASSES["coding-simple"].ranking.map((candidate) => [
        candidate.label,
        candidate.effort,
      ]),
    ).toEqual([
      ["Astra", "medium"],
      ["Fable 5.1", "medium"],
      ["Opus 5", "medium"],
      ["Grok 4.6", "xhigh"],
    ]);
  });

  it("puts Anthropic first for design and for planning", () => {
    for (const classId of ["frontend-ui", "planning"] as const) {
      expect(
        MODEL_PREFERENCE_CLASSES[classId].ranking.map(
          (candidate) => candidate.label,
        ),
      ).toEqual(["Fable 5.1", "Astra", "Opus 5"]);
    }
  });

  it("keeps the simple plugs off the heavy models", () => {
    for (const classId of ["testing-light", "general-light"] as const) {
      expect(
        MODEL_PREFERENCE_CLASSES[classId].ranking.map((candidate) => [
          candidate.label,
          candidate.effort,
        ]),
      ).toEqual([
        ["Opus 5", "medium"],
        ["Grok 4.6", "high"],
        ["Luna", "xhigh"],
      ]);
    }
  });
});

describe("resolveRankedModel", () => {
  it("picks the top preference when everything is available", () => {
    const result = resolveRankedModel("frontend-ui", input());
    // Design work is Anthropic-first: Fable 5.1 → Astra → Opus 5 (2026-09-12).
    expect(result.choice?.label).toBe("Fable 5.1");
    expect(result.choice?.harnessId).toBe("claude-acp");
    expect(result.choice?.model.id).toBe("claude-fable-5-1");
    expect(result.choice?.rankIndex).toBe(0);
    expect(result.skipped).toEqual([]);
  });

  it("falls through a platform at its usage limit, and says so", () => {
    const result = resolveRankedModel(
      "one-shot",
      input({
        platformLimitState: (platform) =>
          platform === "grok-acp" ? "clear" : "at-limit",
      }),
    );
    // one-shot: Astra → Fable 5.1 → Opus 5 → Grok 4.6; everything but Grok
    // is gated here.
    expect(result.choice?.label).toBe("Grok 4.6");
    expect(result.choice?.rankIndex).toBe(3);
    expect(result.skipped).toEqual([
      { label: "Astra", reason: "at-limit" },
      { label: "Fable 5.1", reason: "at-limit" },
      { label: "Opus 5", reason: "at-limit" },
    ]);
  });

  it("keeps Opus when only Fable's own weekly window is spent", () => {
    // The operator's case, verbatim: "if Fable is in cooldown and the next
    // choice is Opus and the Anthropic account still allows it, take Opus".
    // Both live on claude-acp, so a per-platform verdict locked Opus out too.
    const result = resolveRankedModel(
      "one-shot",
      input({
        platformLimitState: (platform, scopedWindow) => {
          if (platform === "codex-acp") return "at-limit";
          return platform === "claude-acp" && scopedWindow === "fableWeekly"
            ? "at-limit"
            : "clear";
        },
      }),
    );

    // one-shot: Astra → Fable 5.1 → Opus 5 → Grok. Astra's platform is spent
    // and Fable is out on its own window; Opus is next on the same platform as
    // Fable and was never gated — exactly the operator's case, and the ranking
    // now says it directly.
    expect(result.choice?.label).toBe("Opus 5");
    expect(result.skipped).toEqual([
      { label: "Astra", reason: "at-limit" },
      { label: "Fable 5.1", reason: "at-limit" },
    ]);
  });

  it("passes over a platform that is merely close to its limit", () => {
    const result = resolveRankedModel(
      "frontend-ui",
      input({
        platformLimitState: (platform) =>
          platform === "claude-acp" ? "near-limit" : "clear",
      }),
    );

    // frontend-ui: Fable 5.1 → Astra → Opus 5. Fable is near its limit, so
    // the work goes to Astra rather than being cut off mid-flight.
    expect(result.choice?.label).toBe("Astra");
    expect(result.choice?.nearLimit).toBeUndefined();
    expect(result.skipped).toEqual([
      { label: "Fable 5.1", reason: "near-limit" },
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

  it("carries the effort the ranking asks for", () => {
    const result = resolveRankedModel("frontend-ui", input());
    expect(result.choice?.effort).toBe("xhigh");
  });

  it("falls through a model that is not installed, keeping the class effort", () => {
    const result = resolveRankedModel(
      "coding-simple",
      input({
        modelsForPlatform: (platform) =>
          platform === "claude-acp" ? CLAUDE_MODELS : [],
      }),
    );
    // coding-simple (medium profile): Astra → Fable 5.1 → Opus 5 → Grok 4.6.
    expect(result.choice?.label).toBe("Fable 5.1");
    expect(result.choice?.effort).toBe("medium");
    expect(result.skipped).toEqual([
      { label: "Astra", reason: "not-installed" },
    ]);
  });

  it("prefers the effort-tier variant the candidate asks for", () => {
    // Codex serves every tier as its own id, ascending — first-match used to
    // hand an xhigh candidate the [low] variant (L1, 2026-08-28).
    const tiers: RankableModel[] = [
      { id: "codex-astra[low]", displayName: "Codex Astra[low]" },
      { id: "codex-astra[medium]", displayName: "Codex Astra[medium]" },
      { id: "codex-astra[xhigh]", displayName: "Codex Astra[xhigh]" },
    ];
    const result = resolveRankedModel(
      "coding-complex",
      input({
        modelsForPlatform: (platform) =>
          platform === "codex-acp" ? tiers : [],
      }),
    );
    // coding-complex: Astra first, and nothing else is installed here.
    expect(result.choice?.label).toBe("Astra");
    expect(result.choice?.model.id).toBe("codex-astra[xhigh]");
  });

  it("keeps the first match when no variant embeds the asked effort", () => {
    const tiers: RankableModel[] = [
      { id: "codex-astra[low]", displayName: "Codex Astra[low]" },
      { id: "codex-astra[ultra]", displayName: "Codex Astra[ultra]" },
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
    expect(result.choice?.model.id).toBe("codex-astra[low]");
  });

  it("searches every harness for a platformless candidate", () => {
    const result = resolveRankedModel(
      "testing-light",
      input({
        modelsForPlatform: () => [],
        allModels: () => [
          { harnessId: "goose", model: { id: "luna-1", displayName: "Luna" } },
        ],
      }),
    );
    expect(result.choice?.label).toBe("Luna");
    expect(result.choice?.harnessId).toBe("goose");
    expect(result.choice?.effort).toBe("xhigh");
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
      "planning",
    );
    expect(
      modelPreferenceClassForPersona({ displayName: "Unity Worker" }),
    ).toBe("coding-complex");
  });

  it("routes the coordinating roles to planning, not to coding", () => {
    // Planning and design are Anthropic-first work (2026-09-12); the roles
    // that decide and sequence rather than implement moved out of one-shot.
    for (const displayName of ["Planner", "Producer", "Oracle"]) {
      expect(modelPreferenceClassForPersona({ displayName })).toBe("planning");
    }
    // Research still ends in a brief, not a plan, so it stays one-shot.
    expect(modelPreferenceClassForPersona({ displayName: "Researcher" })).toBe(
      "one-shot",
    );
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
