import { describe, expect, it } from "vitest";

import {
  candidateForEntry,
  candidatesForRankingSource,
  legacySingleModelRankingEntry,
  parseAgentRankingSource,
  rankingFromClass,
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
    // frontend-ui: Opus → Fable → Sol, and all three are installed here.
    expect(built.entries.map((entry) => entry.label)).toEqual([
      "Opus 5",
      "Fable 5",
      "Codex Sol",
    ]);
    expect(built.entries[0].modelId).toBe("claude-opus-5");
    expect(built.entries[0].effort).toBe("xhigh");
  });

  it("drops a candidate nothing installed can serve", () => {
    const built = rankingFromClass("testing-light", [INSTALLED[3]]);
    // testing-light: Grok → Tera → Luna; only Grok exists on this machine.
    expect(built.entries.map((entry) => entry.label)).toEqual(["Grok 4.6"]);
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
