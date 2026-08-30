import { describe, expect, it } from "vitest";

import {
  candidateForEntry,
  candidatesForRankingSource,
  legacySingleModelRankingEntry,
  parseAgentRankingSource,
  platformForRankingModel,
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

const INSTALLED = [
  {
    platform: "claude-acp" as const,
    modelId: "claude-opus-5",
    label: "Opus 5",
  },
  {
    platform: "claude-acp" as const,
    modelId: "claude-fable-5",
    label: "Fable 5",
  },
  { platform: "codex-acp" as const, modelId: "gpt-5-codex-sol", label: "Sol" },
  { platform: "grok-acp" as const, modelId: "grok-4-6", label: "Grok 4.6" },
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
});

describe("candidateForEntry", () => {
  it("matches the exact id first and the label's words as a fallback", () => {
    const candidate = candidateForEntry(ranking().entries[0]);
    expect(candidate.needles[0]).toEqual(["claude-opus-5"]);
    expect(candidate.needles[1]).toEqual(["opus"]);
    expect(candidate.effort).toBe("xhigh");
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
    // frontend-ui is heavy-profile: Fable → Opus 5 → Sol, all installed here.
    expect(built.entries.map((entry) => entry.label)).toEqual([
      "Fable 5",
      "Opus 5",
      "Codex Sol",
    ]);
    expect(built.entries[0].modelId).toBe("claude-fable-5");
    expect(built.entries[0].effort).toBe("xhigh");
  });

  it("drops a candidate nothing installed can serve", () => {
    const built = rankingFromClass("testing-light", [INSTALLED[3]]);
    // testing-light: Grok → Luna → Opus 5; only Grok exists on this machine.
    expect(built.entries.map((entry) => entry.label)).toEqual(["Grok 4.6"]);
  });

  it("seeds the effort-tier variant the class asks for, not the first match", () => {
    // Codex serves each tier as its own id, ascending. Seeding used to pin
    // an xhigh candidate to [low] — the acceptor persona shipped that way.
    const built = rankingFromClass("coding-complex", [
      INSTALLED[1],
      {
        platform: "codex-acp" as const,
        modelId: "gpt-5.6-sol[low]",
        label: "GPT 5.6 Sol[low]",
      },
      {
        platform: "codex-acp" as const,
        modelId: "gpt-5.6-sol[xhigh]",
        label: "GPT 5.6 Sol[xhigh]",
      },
    ]);
    // coding-complex: Fable → Sol.
    expect(built.entries.map((entry) => entry.modelId)).toEqual([
      "claude-fable-5",
      "gpt-5.6-sol[xhigh]",
    ]);
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
