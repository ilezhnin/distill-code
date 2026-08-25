import { afterEach, describe, expect, it } from "vitest";

import type { Persona } from "@/shared/types/agents";

import {
  resetWaveStepTargetIoForTests,
  resolveWaveStepTarget,
  setWaveStepTargetIoForTests,
} from "./waveStepTarget";

const PROVIDERS = [
  { id: "claude-acp", label: "Claude Code" },
  { id: "grok-acp", label: "Grok" },
];

const MODELS: Record<string, { id: string; displayName: string }[]> = {
  "claude-acp": [
    { id: "claude-opus-5", displayName: "Claude Opus 5" },
    { id: "claude-fable-5", displayName: "Claude Fable 5" },
  ],
  "grok-acp": [{ id: "grok-4-6", displayName: "Grok 4.6" }],
};

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "writer.persona.md",
    displayName: "Writer",
    description: "",
    systemPrompt: "",
    isBuiltin: true,
    writable: false,
    ...overrides,
  } as Persona;
}

function spentClaude(usedPercent: number) {
  return [
    {
      provider: "claude-acp",
      session: {
        usedPercent,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null,
      },
      weekly: null,
      updatedAt: 1,
      error: null,
      status: "ok" as const,
      configured: true,
    },
  ];
}

function install(
  personas: Persona[],
  rateLimits: ReturnType<typeof spentClaude> | [] = [],
) {
  setWaveStepTargetIoForTests({
    personas: () => personas,
    providers: () => PROVIDERS as never,
    modelsForHarness: (harnessId) => (MODELS[harnessId] ?? []) as never,
    rateLimits: () => rateLimits as never,
  });
}

describe("resolveWaveStepTarget", () => {
  afterEach(() => {
    resetWaveStepTargetIoForTests();
  });

  it("runs the step on the role's own ranking, not the conductor's model", () => {
    install([
      persona({
        modelRanking: JSON.stringify({
          version: 1,
          entries: [
            {
              platform: "claude-acp",
              modelId: "claude-opus-5",
              label: "Opus 5",
              effort: "xhigh",
            },
            {
              platform: "grok-acp",
              modelId: "grok-4-6",
              label: "Grok 4.6",
            },
          ],
        }),
      }),
    ]);

    const resolved = resolveWaveStepTarget("writer");
    expect(resolved?.target.modelId).toBe("claude-opus-5");
    expect(resolved?.label).toBe("Opus 5");
    expect(resolved?.fallback).toBe(false);
  });

  it("walks down the ranking when the top model has no room, and flags it", () => {
    install(
      [
        persona({
          modelRanking: JSON.stringify({
            version: 1,
            entries: [
              {
                platform: "claude-acp",
                modelId: "claude-opus-5",
                label: "Opus 5",
              },
              { platform: "grok-acp", modelId: "grok-4-6", label: "Grok 4.6" },
            ],
          }),
        }),
      ],
      spentClaude(100),
    );

    const resolved = resolveWaveStepTarget("writer");
    expect(resolved?.target.modelId).toBe("grok-4-6");
    // The operator is told: a step off its first choice is D5's business.
    expect(resolved?.fallback).toBe(true);
    expect(resolved?.nearLimit).toBe(false);
  });

  it("takes a near-limit model rather than none, and says so", () => {
    install(
      [
        persona({
          modelRanking: JSON.stringify({
            version: 1,
            entries: [
              {
                platform: "claude-acp",
                modelId: "claude-opus-5",
                label: "Opus 5",
              },
            ],
          }),
        }),
      ],
      spentClaude(95),
    );

    const resolved = resolveWaveStepTarget("writer");
    expect(resolved?.target.modelId).toBe("claude-opus-5");
    expect(resolved?.nearLimit).toBe(true);
  });

  it("has no opinion when the role has no persona, so the child inherits", () => {
    install([]);
    expect(resolveWaveStepTarget("writer")).toBeUndefined();
  });

  it("has no opinion when reading the world throws", () => {
    // Fail-open: a wave that could not start because a preference could not be
    // read would be a far worse failure than a step on the conductor's model.
    setWaveStepTargetIoForTests({
      personas: () => {
        throw new Error("store is gone");
      },
    });
    expect(resolveWaveStepTarget("writer")).toBeUndefined();
  });
});
