import { describe, expect, it } from "vitest";

import {
  serializeAgentModelRanking,
  type AgentRankingEntry,
} from "./agentModelRanking";
import type { RankableModel } from "./modelRanking";
import {
  rankedPersonaExecutionTarget,
  type RankedPersonaTargetContext,
} from "./rankedPersonaTarget";

const CLAUDE_EFFORTS = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
  { id: "xhigh", name: "Extra high" },
  { id: "max", name: "Max" },
];

function context(
  modelsByHarness: Record<string, RankableModel[]>,
): RankedPersonaTargetContext {
  return {
    providers: Object.keys(modelsByHarness).map((id) => ({ id })),
    getModelsForHarness: (harnessId) => modelsByHarness[harnessId] ?? [],
    rateLimits: [],
  };
}

function personaWithList(entries: AgentRankingEntry[]) {
  return {
    displayName: "My Agent",
    modelRanking: serializeAgentModelRanking({ version: 1, entries }),
  };
}

describe("rankedPersonaExecutionTarget", () => {
  it("puts a ranked xhigh on the run settings of a claude-acp model", () => {
    const ranked = rankedPersonaExecutionTarget(
      personaWithList([
        {
          platform: "claude-acp",
          modelId: "claude-opus-5",
          label: "Opus 5",
          effort: "xhigh",
        },
      ]),
      context({
        "claude-acp": [
          {
            id: "claude-opus-5",
            displayName: "Opus 5",
            efforts: CLAUDE_EFFORTS,
          },
        ],
      }),
    );

    expect(ranked?.target).toMatchObject({
      harnessId: "claude-acp",
      modelId: "claude-opus-5",
    });
    expect(ranked?.runSettings).toEqual({ effort: "xhigh" });
    expect(ranked?.resolution.choice?.effortApplied).toBe(true);
  });

  it("puts a ranked effort on the run settings of a grok-acp model", () => {
    const ranked = rankedPersonaExecutionTarget(
      personaWithList([
        {
          platform: "grok-acp",
          modelId: "grok-4.6",
          label: "Grok 4.6",
          effort: "high",
        },
      ]),
      context({
        "grok-acp": [
          {
            id: "grok-4.6",
            displayName: "Grok 4.6",
            efforts: [
              { id: "xhigh", name: "Extra High" },
              { id: "high", name: "High" },
              { id: "medium", name: "Medium" },
              { id: "low", name: "Low" },
            ],
            supportsFast: false,
          },
        ],
      }),
    );

    expect(ranked?.target).toMatchObject({
      harnessId: "grok-acp",
      modelId: "grok-4.6",
    });
    expect(ranked?.runSettings).toEqual({ effort: "high" });
  });

  it("applies a built-in class's effort to a claude-acp model the id never carried it on", () => {
    // Producer resolves to the planning profile: Fable 5.1 at xhigh first.
    const ranked = rankedPersonaExecutionTarget(
      { displayName: "Producer" },
      context({
        "claude-acp": [
          {
            id: "claude-fable-5-1[1m]",
            displayName: "Fable 5.1",
            efforts: CLAUDE_EFFORTS,
          },
        ],
      }),
    );

    expect(ranked?.target).toMatchObject({ modelId: "claude-fable-5-1[1m]" });
    expect(ranked?.runSettings).toEqual({ effort: "xhigh" });
  });

  it("still routes to a model that lacks the ranked effort, keeping the effort as intent", () => {
    const ranked = rankedPersonaExecutionTarget(
      personaWithList([
        {
          platform: "claude-acp",
          modelId: "claude-opus-4-6",
          label: "Opus 4.6",
          effort: "xhigh",
        },
      ]),
      context({
        "claude-acp": [
          {
            id: "claude-opus-4-6",
            displayName: "Opus 4.6",
            efforts: CLAUDE_EFFORTS.filter((option) => option.id !== "xhigh"),
            defaultEffort: "high",
          },
        ],
      }),
    );

    expect(ranked?.target).toMatchObject({ modelId: "claude-opus-4-6" });
    expect(ranked?.runSettings).toEqual({ effort: "xhigh" });
    expect(ranked?.resolution.choice?.effortApplied).toBe(false);
  });

  it("carries a ranked fast mode beside the effort", () => {
    const ranked = rankedPersonaExecutionTarget(
      personaWithList([
        {
          platform: "claude-acp",
          modelId: "claude-opus-5",
          label: "Opus 5",
          effort: "xhigh",
          fastMode: true,
        },
      ]),
      context({
        "claude-acp": [
          { id: "claude-opus-5", displayName: "Opus 5", supportsFast: true },
        ],
      }),
    );

    expect(ranked?.runSettings).toEqual({ effort: "xhigh", fast: true });
  });

  it("gives an entry without effort or fast mode empty run settings", () => {
    const ranked = rankedPersonaExecutionTarget(
      personaWithList([
        { platform: "grok-acp", modelId: "grok-4.6", label: "Grok 4.6" },
      ]),
      context({ "grok-acp": [{ id: "grok-4.6", displayName: "Grok 4.6" }] }),
    );

    expect(ranked?.runSettings).toEqual({});
  });
});
