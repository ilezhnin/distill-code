import { describe, expect, it } from "vitest";

import {
  MODEL_CLASS_BY_AGENT_SLUG,
  MODEL_PREFERENCE_CLASSES,
  applyClassOverride,
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
      ["Grok 4.7", "xhigh"],
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
      ["Grok 4.7", "xhigh"],
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
        ["Grok 4.7", "high"],
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
    // coding-simple (medium profile): Astra → Fable 5.1 → Opus 5 → Grok 4.7.
    expect(result.choice?.label).toBe("Fable 5.1");
    expect(result.choice?.effort).toBe("medium");
    expect(result.skipped).toEqual([
      { label: "Astra", reason: "not-installed" },
    ]);
  });

  it("matches a model by its base id and carries the ranked effort beside it", () => {
    // Inventories list one row per model; the effort is its own selection, so
    // the choice names the base id and the effort separately.
    const codex: RankableModel[] = [
      {
        id: "codex-astra",
        displayName: "Codex Astra",
        efforts: [
          { id: "low", name: "Low" },
          { id: "xhigh", name: "Extra high" },
          { id: "ultra", name: "Ultra" },
        ],
      },
    ];
    const result = resolveRankedModel(
      "coding-complex",
      input({
        modelsForPlatform: (platform) =>
          platform === "codex-acp" ? codex : [],
      }),
    );
    // coding-complex: Astra first, and nothing else is installed here.
    expect(result.choice?.label).toBe("Astra");
    expect(result.choice?.model.id).toBe("codex-astra");
    expect(result.choice?.effort).toBe("xhigh");
    expect(result.choice?.effortApplied).toBe(true);
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

  it("spells the effort the way the model advertises it", () => {
    const grok: RankableModel[] = [
      {
        id: "grok-4.7",
        displayName: "Grok 4.7",
        efforts: [{ id: "XHigh", name: "Extra High" }],
      },
    ];
    const result = resolveRankedModel(
      "coding-complex",
      input({
        modelsForPlatform: (platform) => (platform === "grok-acp" ? grok : []),
      }),
    );
    expect(result.choice?.effort).toBe("XHigh");
    expect(result.choice?.effortApplied).toBe(true);
  });

  it("does not claim an effort is applied or refused when the model's efforts are unknown", () => {
    const result = resolveRankedModel("frontend-ui", input());
    expect(result.choice?.effort).toBe("xhigh");
    expect(result.choice?.effortApplied).toBeUndefined();
  });

  it("prefers the harness's main-page row over a More models row of the same family", () => {
    // Fable 5.1 is filed on the main page and Fable 5 under More models; the
    // name heuristic cannot tell those apart, the harness's filing can.
    const claudeRows: RankableModel[] = [
      { id: "claude-fable-5[1m]", displayName: "Fable 5", group: "more" },
      { id: "claude-fable-5-1[1m]", displayName: "Fable 5.1", group: "main" },
      { id: "claude-opus-4-8", displayName: "Opus 4.8", group: "more" },
      // A row the harness did not file is shown on the main page.
      { id: "opus[1m]", displayName: "Opus 5" },
    ];
    const claudeOnly = (rows: RankableModel[]) =>
      input({
        modelsForPlatform: (platform) =>
          platform === "claude-acp" ? rows : [],
      });

    expect(
      resolveRankedModel("frontend-ui", claudeOnly(claudeRows)).choice?.model
        .id,
    ).toBe("claude-fable-5-1[1m]");
    const withoutFable = claudeRows.filter((row) => !row.id.includes("fable"));
    expect(
      resolveRankedModel("coding-complex", claudeOnly(withoutFable)).choice
        ?.model.id,
    ).toBe("opus[1m]");
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

  it("takes a family's current model when older generations are installed too", () => {
    const claudeRows: RankableModel[] = [
      { id: "claude-opus-4-8", displayName: "Opus 4.8" },
      { id: "claude-fable-5[1m]", displayName: "Fable 5" },
      { id: "opus[1m]", displayName: "Opus 5" },
      { id: "claude-fable-5-1[1m]", displayName: "Fable 5.1" },
    ];
    const claudeOnly = (rows: RankableModel[]) =>
      input({
        modelsForPlatform: (platform) =>
          platform === "claude-acp" ? rows : [],
      });

    // frontend-ui: Fable 5.1 → Astra → Opus 5.
    expect(
      resolveRankedModel("frontend-ui", claudeOnly(claudeRows)).choice?.model
        .id,
    ).toBe("claude-fable-5-1[1m]");
    // coding-complex: Astra → Fable 5.1 → Opus 5; without Fable, Opus 5.
    const withoutFable = claudeRows.filter((row) => !row.id.includes("fable"));
    expect(
      resolveRankedModel("coding-complex", claudeOnly(withoutFable)).choice
        ?.model.id,
    ).toBe("opus[1m]");
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

  it("gives an agent named after an Object.prototype member no ranking", () => {
    // "Constructor" is a natural name for a builder persona. Slugged, it is
    // `constructor`, which a plain-object lookup finds on the prototype and
    // hands back as a truthy function; every consumer then indexes
    // MODEL_PREFERENCE_CLASSES with it and throws while rendering.
    for (const displayName of [
      "Constructor",
      "ToString",
      "Value Of",
      "HasOwnProperty",
      "__proto__",
    ]) {
      expect(modelPreferenceClassForPersona({ displayName })).toBeUndefined();
    }
  });

  it("refuses an Object.prototype member as a class id", () => {
    for (const value of ["constructor", "toString", "__proto__", "valueOf"]) {
      expect(isModelPreferenceClassId(value)).toBe(false);
      expect(
        modelPreferenceClassForPersona({ modelRanking: value }),
      ).toBeUndefined();
    }
  });
});

describe("applyClassOverride", () => {
  it("does not read a legacy label off Object.prototype", () => {
    const ranking = MODEL_PREFERENCE_CLASSES["coding-simple"].ranking;
    expect(applyClassOverride(ranking, ["constructor", "__proto__"])).toBe(
      ranking,
    );
    expect(
      applyClassOverride(ranking, ["toString", "Opus 5"]).map(
        (candidate) => candidate.label,
      ),
    ).toEqual(["Opus 5"]);
  });
});
