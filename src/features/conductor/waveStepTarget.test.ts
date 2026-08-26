import { afterEach, describe, expect, it } from "vitest";

import type { Persona } from "@/shared/types/agents";

import {
  checkExplicitWaveStepModel,
  resetWaveStepTargetIoForTests,
  resolveExplicitWaveStepModel,
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

describe("resolveExplicitWaveStepModel (4a)", () => {
  afterEach(() => {
    resetWaveStepTargetIoForTests();
  });

  it("resolves an exact model id to a full target on its own harness", () => {
    install([]);
    const resolved = resolveExplicitWaveStepModel("claude-opus-5");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.target).toMatchObject({
      harnessId: "claude-acp",
      modelProviderId: "claude-acp",
      modelId: "claude-opus-5",
    });
    expect(resolved.label).toBe("Claude Opus 5");
    expect(resolved.limit).toBe("clear");
  });

  it("resolves a display-name fragment the way the ranking matches", () => {
    // "opus" must find claude-opus-5 exactly as a renamed ranking entry would:
    // the conductor writes names, not inventory ids.
    install([]);
    const resolved = resolveExplicitWaveStepModel("opus");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.target.modelId).toBe("claude-opus-5");
  });

  it("refuses an unknown model, listing what is installed", () => {
    install([]);
    const resolved = resolveExplicitWaveStepModel("gpt-5");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.detail).toContain('"gpt-5"');
    expect(resolved.detail).toContain("Claude Opus 5");
    expect(resolved.detail).toContain("Grok 4.6");
  });

  it("refuses rather than guesses when no inventory is readable", () => {
    // Fail-closed, unlike the ranking: an explicit model is an instruction,
    // and "could not check it" must never quietly become "inherit" (D5).
    setWaveStepTargetIoForTests({
      personas: () => [],
      providers: () => [] as never,
      modelsForHarness: () => [],
      rateLimits: () => [] as never,
    });
    const resolved = resolveExplicitWaveStepModel("opus");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.detail).toContain("no agent provider");
  });

  it("refuses when reading the world throws, quoting the failure", () => {
    setWaveStepTargetIoForTests({
      providers: () => {
        throw new Error("store is gone");
      },
    });
    const resolved = resolveExplicitWaveStepModel("opus");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.detail).toContain("store is gone");
  });

  it("reports the platform's limit state without judging it", () => {
    install([], spentClaude(95));
    const near = resolveExplicitWaveStepModel("opus");
    expect(near.ok).toBe(true);
    if (near.ok) expect(near.limit).toBe("near-limit");

    install([], spentClaude(100));
    const spent = resolveExplicitWaveStepModel("opus");
    expect(spent.ok).toBe(true);
    if (spent.ok) expect(spent.limit).toBe("at-limit");
  });
});

describe("checkExplicitWaveStepModel (admission gate)", () => {
  afterEach(() => {
    resetWaveStepTargetIoForTests();
  });

  it("passes an installed model with room on its window", () => {
    install([]);
    expect(checkExplicitWaveStepModel("grok")).toEqual({ ok: true });
  });

  it("refuses an at-limit model while there is still time to replan", () => {
    install([], spentClaude(100));
    const check = checkExplicitWaveStepModel("opus");
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.detail).toContain("Claude Opus 5");
    expect(check.detail).toContain("usage limit");
  });

  it("admits a near-limit model; the spawn warns instead", () => {
    // An explicit model has no fallback to walk to — refusing at 91% would
    // block plans the meter still allows, so near-limit is a warning, not a
    // refusal.
    install([], spentClaude(95));
    expect(checkExplicitWaveStepModel("opus")).toEqual({ ok: true });
  });
});
