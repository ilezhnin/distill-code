import { describe, expect, it } from "vitest";
import {
  rankedPersonaExecutionTarget,
  rankedPersonaExecutionTargets,
  type RankedPersonaTargetContext,
} from "./rankedPersonaTarget";

describe("ranked persona candidate pool", () => {
  const persona = {
    displayName: "Example helper",
    modelRanking: JSON.stringify({
      version: 1,
      entries: [
        {
          platform: "claude-acp",
          modelId: "example-alpha",
          label: "Alpha",
          effort: "high",
        },
        {
          platform: "codex-acp",
          modelId: "example-beta",
          label: "Beta",
          effort: "low",
        },
        { platform: "grok-acp", modelId: "example-gamma", label: "Gamma" },
      ],
    }),
  };
  function context(): RankedPersonaTargetContext {
    const inventories = {
      "claude-acp": [{ id: "example-alpha" }],
      "codex-acp": [{ id: "example-beta" }],
      "grok-acp": [{ id: "example-gamma" }],
    };
    return {
      providers: Object.keys(inventories).map((id) => ({ id })),
      getModelsForHarness: (id) =>
        inventories[id as keyof typeof inventories] ?? [],
      rateLimits: ["claude-acp", "codex-acp", "grok-acp"].map(
        (provider, index) => ({
          provider,
          session: {
            usedPercent: [90, 10, 100][index],
            windowMinutes: 300,
            resetsAt: null,
            resetDescription: null,
          },
          weekly: null,
          updatedAt: Date.now(),
          error: null,
          status: "ok",
          configured: true,
        }),
      ),
      nearLimitPercent: 80,
    };
  }

  it("keeps the clear candidate ahead of near-limit choices and excludes exhausted accounts", () => {
    const input = context();
    const pool = rankedPersonaExecutionTargets(persona, input);
    expect(pool.map((row) => row.target.modelId)).toEqual([
      "example-beta",
      "example-alpha",
    ]);
    expect(pool.map((row) => row.resolution.choice?.rankIndex)).toEqual([1, 0]);
    expect(pool[0].runSettings).toEqual({ effort: "low" });
    expect(rankedPersonaExecutionTarget(persona, input)).toEqual(pool[0]);
  });

  it("retains distinct efforts while collapsing duplicate preferences", () => {
    const input = context();
    input.rateLimits = [];
    const customized = {
      ...persona,
      modelRanking: JSON.stringify({
        version: 1,
        entries: [
          {
            platform: "codex-acp",
            modelId: "example-beta",
            label: "First",
            effort: "low",
          },
          {
            platform: "codex-acp",
            modelId: "example-beta",
            label: "Duplicate",
            effort: "low",
          },
          {
            platform: "codex-acp",
            modelId: "example-beta",
            label: "More reasoning",
            effort: "high",
          },
        ],
      }),
    };
    const pool = rankedPersonaExecutionTargets(customized, input);
    expect(pool.map((row) => row.runSettings.effort)).toEqual(["low", "high"]);
    expect(pool.map((row) => row.resolution.choice?.rankIndex)).toEqual([0, 2]);
  });
});
