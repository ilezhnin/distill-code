import { describe, expect, it } from "vitest";

import type { Persona } from "@/shared/types/agents";

import { rankedPersonaExecutionTarget } from "./rankedPersonaTarget";

function persona(modelRanking?: string): Persona {
  return {
    id: "writer.persona.md",
    displayName: "Writer",
    description: "",
    systemPrompt: "",
    isBuiltin: true,
    writable: false,
    ...(modelRanking ? { modelRanking } : {}),
  } as Persona;
}

const LIST = JSON.stringify({
  version: 1,
  entries: [
    {
      platform: "claude-acp",
      modelId: "claude-opus-5",
      label: "Opus 5",
      effort: "xhigh",
    },
  ],
});

function context(
  models: Array<{ id: string; displayName?: string; providerId?: string }>,
) {
  return {
    providers: [{ id: "claude-acp" }],
    getModelsForHarness: () => models,
    rateLimits: [],
  };
}

describe("rankedPersonaExecutionTarget", () => {
  it("names the provider that serves the model it picked", () => {
    // The normalizer refuses a concrete model with no provider id, so without
    // this the ranking threw on every resolution it made and could not
    // retarget anything at all.
    const resolved = rankedPersonaExecutionTarget(
      persona(LIST),
      context([
        {
          id: "claude-opus-5",
          displayName: "Claude Opus 5",
          providerId: "claude-acp",
        },
      ]),
    );

    expect(resolved?.target).toMatchObject({
      harnessId: "claude-acp",
      modelProviderId: "claude-acp",
      modelId: "claude-opus-5",
    });
    expect(resolved?.resolution.choice?.effort).toBe("xhigh");
  });

  it("falls back to the harness when a model carries no provider of its own", () => {
    const resolved = rankedPersonaExecutionTarget(
      persona(LIST),
      context([{ id: "claude-opus-5", displayName: "Claude Opus 5" }]),
    );

    expect(resolved?.target.modelProviderId).toBe("claude-acp");
  });

  it("yields rather than throws when the target cannot be built", () => {
    // A preference must never stop a session from starting.
    const resolved = rankedPersonaExecutionTarget(persona(LIST), {
      providers: [{ id: "claude-acp" }],
      getModelsForHarness: () => [
        // A goose-fanned model whose provider is the harness itself is exactly
        // the shape the normalizer rejects.
        { id: "claude-opus-5", providerId: "goose" },
      ],
      rateLimits: [],
    });

    expect(resolved?.target.modelProviderId).toBe("goose");
  });

  it("has no opinion for a persona with no ranking and no known role", () => {
    expect(
      rankedPersonaExecutionTarget(
        { ...persona(), displayName: "Nobody In Particular" } as Persona,
        context([{ id: "claude-opus-5" }]),
      ),
    ).toBeUndefined();
  });
});
