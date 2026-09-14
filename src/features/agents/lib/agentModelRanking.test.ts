import { describe, expect, it, vi } from "vitest";

import {
  candidateForEntry,
  candidatesForRankingSource,
  legacySingleModelRankingEntry,
  parseAgentRankingSource,
  platformForRankingModel,
  rankingEffortChoices,
  rankingFromClass,
  rankingInventoryFromProviders,
  scopedWindowForModel,
  serializeAgentModelRanking,
  type AgentModelRanking,
} from "./agentModelRanking";
import {
  resolveRankedCandidates,
  type RankableModel,
  type RankedModelResolutionInput,
} from "./modelRanking";

const INSTALLED_OPUS = {
  platform: "claude-acp" as const,
  modelId: "claude-opus-5",
  label: "Opus 5",
};
const INSTALLED_FABLE = {
  platform: "claude-acp" as const,
  modelId: "claude-fable-5-1",
  label: "Claude Fable 5.1",
};
const INSTALLED_ASTRA = {
  platform: "codex-acp" as const,
  modelId: "codex-astra",
  label: "Codex Astra",
};
const INSTALLED_GROK = {
  platform: "grok-acp" as const,
  modelId: "grok-4-6",
  label: "Grok 4.6",
};
const INSTALLED = [
  INSTALLED_OPUS,
  INSTALLED_FABLE,
  INSTALLED_ASTRA,
  { platform: "codex-acp" as const, modelId: "gpt-5-codex-sol", label: "Sol" },
  INSTALLED_GROK,
];

function ranking(): AgentModelRanking {
  return {
    version: 1,
    entries: [
      {
        platform: "claude-acp",
        modelId: "claude-opus-5",
        label: "Opus 5",
        effort: "xhigh",
      },
      {
        platform: "claude-acp",
        modelId: "claude-fable-5",
        label: "Fable 5",
        effort: "xhigh",
      },
      { platform: "grok-acp", modelId: "grok-4-6", label: "Grok 4.6" },
    ],
  };
}

function input(
  overrides: Partial<RankedModelResolutionInput> = {},
): RankedModelResolutionInput {
  const byPlatform: Record<string, RankableModel[]> = {
    "claude-acp": [
      { id: "claude-opus-5", displayName: "Claude Opus 5" },
      { id: "claude-fable-5", displayName: "Claude Fable 5" },
    ],
    "codex-acp": [{ id: "gpt-5-codex-sol", displayName: "Codex Sol" }],
    "grok-acp": [{ id: "grok-4-6", displayName: "Grok 4.6" }],
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

describe("parseAgentRankingSource", () => {
  it("still reads a built-in class id", () => {
    // Every agent written before per-agent lists stores one of these.
    expect(parseAgentRankingSource("frontend-ui")).toEqual({
      kind: "class",
      classId: "frontend-ui",
    });
  });

  it("round-trips an explicit list", () => {
    const source = parseAgentRankingSource(
      serializeAgentModelRanking(ranking()),
    );
    expect(source?.kind).toBe("list");
    if (source?.kind !== "list") return;
    expect(source.ranking.entries).toEqual(ranking().entries);
  });

  it("reads a bare array as the list", () => {
    const source = parseAgentRankingSource(
      JSON.stringify(ranking().entries.slice(0, 1)),
    );
    expect(source?.kind).toBe("list");
  });

  it("keeps the readable entries of a half-broken list", () => {
    // Dropping the whole list on one bad row would silently retarget every
    // session the agent starts — the exact failure this feature prevents.
    const source = parseAgentRankingSource(
      JSON.stringify({
        version: 1,
        entries: [
          { platform: "nope-acp", modelId: "x", label: "X" },
          { platform: "claude-acp", modelId: "", label: "empty" },
          { platform: "grok-acp", modelId: "grok-4-6", label: "Grok 4.6" },
        ],
      }),
    );
    expect(source?.kind).toBe("list");
    if (source?.kind !== "list") return;
    expect(source.ranking.entries).toHaveLength(1);
    expect(source.ranking.entries[0].modelId).toBe("grok-4-6");
  });

  it("drops a Goose-platform row rather than keeping a dead preference", () => {
    // Goose has no rate-limit meter. A ranking that stored it would look
    // chosen and then vanish at resolution — the same silent miss as a
    // row whose platform id was never in the tracked set.
    const source = parseAgentRankingSource(
      JSON.stringify({
        version: 1,
        entries: [
          { platform: "goose", modelId: "gpt-4.1", label: "GPT-4.1" },
          { platform: "grok-acp", modelId: "grok-4-6", label: "Grok 4.6" },
        ],
      }),
    );
    expect(source?.kind).toBe("list");
    if (source?.kind !== "list") return;
    expect(source.ranking.entries).toHaveLength(1);
    expect(source.ranking.entries[0].modelId).toBe("grok-4-6");
  });

  it("has no opinion on nothing, junk, or an empty list", () => {
    expect(parseAgentRankingSource(undefined)).toBeUndefined();
    expect(parseAgentRankingSource("  ")).toBeUndefined();
    expect(parseAgentRankingSource("{not json")).toBeUndefined();
    expect(parseAgentRankingSource('{"entries":[]}')).toBeUndefined();
  });

  it("reads a stored folded id as the base model plus its effort", () => {
    // Entries written before model and effort were separate selections. The
    // stored value is only read: it changes when the operator next saves.
    const stored = JSON.stringify({
      version: 1,
      entries: [
        {
          platform: "codex-acp",
          modelId: "codex-astra[xhigh]",
          label: "Codex Astra[xhigh]",
        },
      ],
    });
    expect(parseAgentRankingSource(stored)).toEqual({
      kind: "list",
      ranking: {
        version: 1,
        entries: [
          {
            platform: "codex-acp",
            modelId: "codex-astra",
            label: "Codex Astra",
            effort: "xhigh",
          },
        ],
      },
    });
  });

  it("lets an explicit effort win over a folded id's and reports the conflict once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stored = JSON.stringify([
      {
        platform: "codex-acp",
        modelId: "gpt-5.6-terra[xhigh]",
        label: "Terra",
        effort: "medium",
      },
    ]);
    const first = parseAgentRankingSource(stored);
    parseAgentRankingSource(stored);

    expect(first?.kind === "list" && first.ranking.entries[0]).toMatchObject({
      modelId: "gpt-5.6-terra",
      effort: "medium",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("never splits a context-lane id", () => {
    const source = parseAgentRankingSource(
      JSON.stringify([
        { platform: "claude-acp", modelId: "opus[1m]", label: "Opus 5" },
      ]),
    );
    expect(source?.kind === "list" && source.ranking.entries[0]).toEqual({
      platform: "claude-acp",
      modelId: "opus[1m]",
      label: "Opus 5",
    });
  });

  it("keeps an entry's fast mode through a round trip", () => {
    const withFast: AgentModelRanking = {
      version: 1,
      entries: [
        {
          platform: "claude-acp",
          modelId: "claude-opus-5",
          label: "Opus 5",
          effort: "xhigh",
          fastMode: true,
        },
      ],
    };
    const source = parseAgentRankingSource(
      serializeAgentModelRanking(withFast),
    );
    expect(source?.kind === "list" && source.ranking.entries).toEqual(
      withFast.entries,
    );
  });

  it("does not take an Object.prototype member for a class id", () => {
    // `model_ranking: constructor` in an agent-writable frontmatter used to
    // parse as a class and then throw in every consumer that indexed the
    // class table with it.
    for (const raw of ["constructor", "toString", "__proto__"]) {
      expect(parseAgentRankingSource(raw)).toBeUndefined();
    }
  });
});

describe("candidateForEntry", () => {
  it("matches the exact id first and the label's words as a fallback", () => {
    const candidate = candidateForEntry(ranking().entries[0]);
    expect(candidate.needles[0]).toEqual(["claude-opus-5"]);
    expect(candidate.needles[1]).toEqual(["opus"]);
    expect(candidate.effort).toBe("xhigh");
  });

  it("builds effort-free needles from a folded id and label", () => {
    // The word "low" inside a folded label used to be part of the match, so
    // the entry could only find the tier it was written against.
    const candidate = candidateForEntry({
      platform: "codex-acp",
      modelId: "codex-astra[low]",
      label: "Codex Astra[low]",
    });
    expect(candidate.needles).toEqual([["codex-astra"], ["codex", "astra"]]);
    expect(candidate.label).toBe("Codex Astra");
    expect(candidate.effort).toBe("low");
  });

  it("carries an entry's fast mode onto the candidate", () => {
    expect(
      candidateForEntry({
        platform: "claude-acp",
        modelId: "claude-opus-5",
        label: "Opus 5",
        fastMode: true,
      }).fast,
    ).toBe(true);
  });

  it("gives Fable its own weekly window and nobody else", () => {
    expect(candidateForEntry(ranking().entries[1]).scopedWindow).toBe(
      "fableWeekly",
    );
    expect(
      candidateForEntry(ranking().entries[0]).scopedWindow,
    ).toBeUndefined();
    expect(
      scopedWindowForModel("grok-acp", "grok-4-6", "Grok 4.6"),
    ).toBeUndefined();
  });

  it("still resolves a model whose id drifted under its label", () => {
    const drifted = candidateForEntry({
      platform: "claude-acp",
      modelId: "claude-opus-5",
      label: "Opus 5",
    });
    const result = resolveRankedCandidates(
      [drifted],
      input({
        modelsForPlatform: (platform) =>
          platform === "claude-acp"
            ? [{ id: "claude-opus-5-20261101", displayName: "Claude Opus 5" }]
            : [],
      }),
    );
    expect(result.choice?.model.id).toBe("claude-opus-5-20261101");
  });
});

describe("an agent's own list, resolved", () => {
  it("walks the operator's order", () => {
    const result = resolveRankedCandidates(
      candidatesForRankingSource({ kind: "list", ranking: ranking() }),
      input(),
    );
    expect(result.choice?.label).toBe("Opus 5");
    expect(result.choice?.effort).toBe("xhigh");
  });

  it("passes Opus over for Grok when Anthropic is spent, Fable window aside", () => {
    const result = resolveRankedCandidates(
      candidatesForRankingSource({ kind: "list", ranking: ranking() }),
      input({
        platformLimitState: (platform) =>
          platform === "claude-acp" ? "at-limit" : "clear",
      }),
    );
    expect(result.choice?.label).toBe("Grok 4.6");
    expect(result.skipped.map((skip) => skip.label)).toEqual([
      "Opus 5",
      "Fable 5",
    ]);
  });
});

describe("rankingFromClass", () => {
  it("renders a class against what is actually installed", () => {
    const built = rankingFromClass("frontend-ui", INSTALLED);
    // frontend-ui is the design profile: Fable 5.1 → Astra → Opus 5, all
    // installed here.
    expect(built.entries.map((entry) => entry.label)).toEqual([
      "Fable 5.1",
      "Astra",
      "Opus 5",
    ]);
    expect(built.entries[0].modelId).toBe("claude-fable-5-1");
    expect(built.entries[0].effort).toBe("xhigh");
  });

  it("drops a candidate nothing installed can serve", () => {
    const built = rankingFromClass("testing-light", [INSTALLED_GROK]);
    // testing-light: Opus 5 → Grok 4.6 → Luna; only Grok exists here.
    expect(built.entries.map((entry) => entry.label)).toEqual(["Grok 4.6"]);
    expect(built.entries[0].effort).toBe("high");
  });

  it("seeds a base model id with the class's effort as its own field", () => {
    const built = rankingFromClass("coding-complex", [
      INSTALLED_FABLE,
      INSTALLED_ASTRA,
    ]);
    // coding-complex: Astra → Fable 5.1 → Opus 5 → Grok; two are installed.
    expect(built.entries).toEqual([
      {
        platform: "codex-acp",
        modelId: "codex-astra",
        label: "Astra",
        effort: "xhigh",
      },
      {
        platform: "claude-acp",
        modelId: "claude-fable-5-1",
        label: "Fable 5.1",
        effort: "xhigh",
      },
    ]);
  });
});

describe("rankingEffortChoices", () => {
  it("offers exactly the efforts the selected model advertises, max and ultra included", () => {
    expect(
      rankingEffortChoices(
        {},
        {
          efforts: [
            { id: "low", name: "Low" },
            { id: "max", name: "Max" },
            { id: "ultra", name: "Ultra" },
          ],
        },
      ),
    ).toEqual([
      { id: "low", name: "Low", unlisted: false },
      { id: "max", name: "Max", unlisted: false },
      { id: "ultra", name: "Ultra", unlisted: false },
    ]);
  });

  it("keeps a stored effort the model does not offer, marked as unlisted", () => {
    expect(
      rankingEffortChoices(
        { effort: "xhigh" },
        { efforts: [{ id: "high", name: "High" }] },
      ),
    ).toEqual([
      { id: "high", name: "High", unlisted: false },
      { id: "xhigh", name: "xhigh", unlisted: true },
    ]);
  });

  it("offers only the stored effort when nobody knows the model's efforts", () => {
    expect(rankingEffortChoices({ effort: "xhigh" }, undefined)).toEqual([
      { id: "xhigh", name: "xhigh", unlisted: false },
    ]);
    expect(rankingEffortChoices({}, { efforts: [] })).toEqual([]);
  });
});

describe("rankingInventoryFromProviders", () => {
  it("maps Goose-catalog names onto metered platforms and skips the rest", () => {
    const items = rankingInventoryFromProviders(
      [{ id: "goose", label: "Goose" }],
      () => [
        { id: "gpt-4.1", displayName: "GPT-4.1" },
        { id: "claude-opus-5", displayName: "Opus 5" },
        { id: "grok-4-6", displayName: "Grok 4.6" },
      ],
    );

    expect(items.map((item) => [item.platform, item.modelId])).toEqual([
      ["claude-acp", "claude-opus-5"],
      ["grok-acp", "grok-4-6"],
    ]);
  });

  it("lets a native ACP list win the label over the same Goose id", () => {
    const byProvider: Record<
      string,
      Array<{ id: string; displayName: string }>
    > = {
      "claude-acp": [{ id: "claude-opus-5", displayName: "Claude Opus 5" }],
      goose: [{ id: "claude-opus-5", displayName: "Opus 5 via Goose" }],
    };
    const items = rankingInventoryFromProviders(
      [
        { id: "goose", label: "Goose" },
        { id: "claude-acp", label: "Claude Code" },
      ],
      (id) => byProvider[id] ?? [],
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.providerLabel).toBe("Claude Code");
    expect(items[0]?.label).toBe("Claude Opus 5");
  });

  it("does not treat a Goose harness id as a stored platform", () => {
    expect(
      platformForRankingModel("goose", {
        id: "gpt-4.1",
        displayName: "GPT-4.1",
      }),
    ).toBeNull();
  });
});

describe("legacySingleModelRankingEntry", () => {
  it("renders a saved provider/model pair as one ranking row", () => {
    const entry = legacySingleModelRankingEntry({
      provider: "grok-acp",
      model: "grok-4-6",
      label: "Grok 4.6",
    });

    expect(entry).toEqual({
      platform: "grok-acp",
      modelId: "grok-4-6",
      label: "Grok 4.6",
    });
  });

  it("seeds a legacy folded model as its base id plus effort", () => {
    expect(
      legacySingleModelRankingEntry({
        provider: "codex-acp",
        model: "gpt-5.6-sol[ultra]",
      }),
    ).toEqual({
      platform: "codex-acp",
      modelId: "gpt-5.6-sol",
      label: "gpt-5.6-sol",
      effort: "ultra",
    });
  });

  it("falls back to the model id when no display label is known", () => {
    const entry = legacySingleModelRankingEntry({
      provider: "grok-acp",
      model: "grok-4-6",
    });

    expect(entry?.label).toBe("grok-4-6");
  });

  it("refuses a provider that is not a ranked platform", () => {
    // goose-routed models have no rate-limit meter, so a seed row would be a
    // ranking entry the resolver could never honestly walk.
    expect(
      legacySingleModelRankingEntry({ provider: "goose", model: "gpt-5" }),
    ).toBeNull();
  });

  it("refuses when no single model is saved", () => {
    expect(
      legacySingleModelRankingEntry({ provider: "grok-acp", model: "  " }),
    ).toBeNull();
  });
});
