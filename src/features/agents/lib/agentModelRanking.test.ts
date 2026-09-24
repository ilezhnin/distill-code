import { describe, expect, it, vi } from "vitest";

import {
  candidatesForRankingSource,
  parseAgentRankingSource,
  rankingEffortChoices,
  type AgentModelRanking,
} from "./agentModelRanking";
import {
  resolveRankedCandidates,
  type RankableModel,
  type RankedModelResolutionInput,
} from "./modelRanking";

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

  it("does not take an Object.prototype member for a class id", () => {
    // `model_ranking: constructor` in an agent-writable frontmatter used to
    // parse as a class and then throw in every consumer that indexed the
    // class table with it.
    for (const raw of ["constructor", "toString", "__proto__"]) {
      expect(parseAgentRankingSource(raw)).toBeUndefined();
    }
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

describe("rankingEffortChoices", () => {
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
});
